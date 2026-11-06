// =============================================================
// server.js — Servidor web (Express) e rotas da API
// =============================================================

const path = require('path');
const { performance } = require('perf_hooks');
const express = require('express');

const { prepararBanco, gerarRelatorio } = require('./db');
const { redis, conectarRedis, redisDisponivel } = require('./cache');
const { executarTarefaPesada } = require('./tarefa');

const PORTA = process.env.PORT || 3000;
const CHAVE_CACHE = 'relatorio:vendas'; // nome da chave no Redis
const EXPIRACAO_SEGUNDOS = 60; // tempo de vida do cache

// Tarefa pesada (análise anual completa, ~2 minutos no banco)
const CHAVE_TAREFA = 'relatorio:analise-anual';
const EXPIRACAO_TAREFA = 10 * 60; // 10 minutos: um cálculo de 2 min merece um cache mais longo

const MENSAGEM_REDIS_OFF =
  'Não foi possível falar com o Redis. Verifique se ele está ligado (docker compose up -d) e tente novamente.';

// Arredonda o tempo para 3 casas decimais (ex.: 0.412 ms).
const arredondar = (ms) => Math.round(ms * 1000) / 1000;

// 1) Prepara o banco (cria a tabela e gera os dados, se necessário)
prepararBanco();

// 2) Conecta no Redis (se estiver desligado, o servidor sobe mesmo assim)
conectarRedis();

const app = express();

// Serve os arquivos do front-end (HTML, CSS e JS) da pasta "public"
app.use(express.static(path.join(__dirname, 'public')));

// -------------------------------------------------------------
// GET /api/sem-redis → consulta SEMPRE direto no banco
// -------------------------------------------------------------
app.get('/api/sem-redis', (req, res) => {
  const inicio = performance.now();

  const dados = gerarRelatorio(); // consulta pesada no SQLite

  const tempoMs = performance.now() - inicio;
  res.json({ origem: 'banco', tempoMs: arredondar(tempoMs), dados });
});

// -------------------------------------------------------------
// GET /api/com-redis → procura primeiro no cache (Redis)
// -------------------------------------------------------------
app.get('/api/com-redis', async (req, res) => {
  if (!redisDisponivel()) {
    return res.status(503).json({ erro: MENSAGEM_REDIS_OFF });
  }

  try {
    const inicio = performance.now();

    // Passo 1: procura o relatório no Redis
    const emCache = await redis.get(CHAVE_CACHE);

    if (emCache) {
      // HIT: o relatório já estava no cache, basta devolver
      const dados = JSON.parse(emCache);
      const tempoMs = performance.now() - inicio;
      return res.json({ origem: 'cache', tempoMs: arredondar(tempoMs), dados });
    }

    // MISS: não estava no cache → consulta o banco...
    const dados = gerarRelatorio();

    // ...e guarda no Redis por 60 segundos (EX = expiração em segundos)
    await redis.set(CHAVE_CACHE, JSON.stringify(dados), { EX: EXPIRACAO_SEGUNDOS });

    const tempoMs = performance.now() - inicio;
    return res.json({ origem: 'banco', tempoMs: arredondar(tempoMs), dados });
  } catch (erro) {
    console.error('Erro ao usar o Redis:', erro.message);
    return res.status(503).json({ erro: MENSAGEM_REDIS_OFF });
  }
});

// -------------------------------------------------------------
// DELETE /api/cache → apaga o relatório do Redis (força um MISS)
// -------------------------------------------------------------
app.delete('/api/cache', async (req, res) => {
  if (!redisDisponivel()) {
    return res.status(503).json({ erro: MENSAGEM_REDIS_OFF });
  }

  try {
    const apagadas = await redis.del(CHAVE_CACHE);
    res.json({ mensagem: apagadas ? 'Cache apagado!' : 'O cache já estava vazio.' });
  } catch (erro) {
    res.status(503).json({ erro: MENSAGEM_REDIS_OFF });
  }
});

// -------------------------------------------------------------
// GET /api/status → informa se o Redis está ligado (usado nas páginas)
// -------------------------------------------------------------
app.get('/api/status', (req, res) => {
  res.json({ redis: redisDisponivel() });
});

// =============================================================
// TAREFA PESADA — análise anual completa (~2 minutos no banco)
// =============================================================
// GET /api/tarefa?modo=banco  → calcula sempre no banco
// GET /api/tarefa?modo=redis  → procura no Redis; se não achar, calcula e guarda
//
// A resposta é um "stream" (Server-Sent Events): o servidor vai
// mandando ao navegador cada consulta que o banco executa, ao vivo.
app.get('/api/tarefa', async (req, res) => {
  const modo = req.query.modo === 'redis' ? 'redis' : 'banco';

  // Cabeçalhos do Server-Sent Events
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();

  let tarefa = null;
  let encerrado = false;

  // Se o usuário fechar a página, interrompe a tarefa no meio
  res.on('close', () => {
    if (!encerrado && tarefa && !res.writableEnded) {
      console.log(`⏹️  Tarefa (${modo}) cancelada: o navegador fechou a conexão.`);
    }
    encerrado = true;
    if (tarefa) tarefa.cancelar();
  });

  // Envia um evento para o navegador
  const enviar = (evento, dados) => {
    if (!encerrado) res.write(`event: ${evento}\ndata: ${JSON.stringify(dados)}\n\n`);
  };
  const log = (texto, tipo) => enviar('log', { texto, tipo });

  const inicio = performance.now();
  const finalizar = (origem, resultado) => {
    enviar('fim', { origem, tempoMs: arredondar(performance.now() - inicio), resultado });
    res.end();
  };

  try {
    if (modo === 'redis') {
      if (!redisDisponivel()) {
        enviar('erro', { erro: MENSAGEM_REDIS_OFF });
        return res.end();
      }

      // Passo 1: procura o resultado pronto no Redis
      log(`GET ${CHAVE_TAREFA}`, 'redis');
      const emCache = await redis.get(CHAVE_TAREFA);

      if (emCache) {
        // HIT: devolve na hora, sem tocar no banco
        const resultado = JSON.parse(emCache);
        const kb = (Buffer.byteLength(emCache) / 1024).toFixed(0);
        log(`HIT! Resultado pronto encontrado no cache (${kb} KB). Nenhuma consulta ao banco foi necessária.`, 'hit');
        return finalizar('cache', resultado);
      }

      log('MISS: o resultado ainda não está no cache. Será preciso calcular no banco...', 'miss');
    }

    // Passo 2: calcula no banco (numa thread separada), repassando o progresso
    tarefa = executarTarefaPesada((mensagem) => {
      if (mensagem.tipo !== 'fim') enviar(mensagem.tipo, mensagem);
    });
    const resultado = await tarefa.pronto;

    // Passo 3 (só com Redis): guarda o resultado para as próximas vezes
    if (modo === 'redis') {
      try {
        await redis.set(CHAVE_TAREFA, JSON.stringify(resultado), { EX: EXPIRACAO_TAREFA });
        log(`SET ${CHAVE_TAREFA} EX ${EXPIRACAO_TAREFA} → guardado no cache por 10 minutos`, 'redis');
      } catch {
        log('Não foi possível guardar no Redis (ele foi desligado?).', 'miss');
      }
    }

    finalizar('banco', resultado);
  } catch (erro) {
    if (!encerrado) {
      enviar('erro', { erro: modo === 'redis' && !redisDisponivel() ? MENSAGEM_REDIS_OFF : 'Erro: ' + erro.message });
      res.end();
    }
  }
});

// GET /api/tarefa/cache → informa se o resultado está no Redis e quando expira
app.get('/api/tarefa/cache', async (req, res) => {
  if (!redisDisponivel()) return res.json({ redis: false });
  try {
    const ttl = await redis.ttl(CHAVE_TAREFA); // -2 = a chave não existe
    res.json({ redis: true, existe: ttl > 0, ttl });
  } catch {
    res.json({ redis: false });
  }
});

// DELETE /api/tarefa/cache → apaga o resultado da tarefa do Redis
app.delete('/api/tarefa/cache', async (req, res) => {
  if (!redisDisponivel()) return res.status(503).json({ erro: MENSAGEM_REDIS_OFF });
  try {
    await redis.del(CHAVE_TAREFA);
    res.json({ mensagem: 'Cache da análise apagado!' });
  } catch {
    res.status(503).json({ erro: MENSAGEM_REDIS_OFF });
  }
});

app.listen(PORTA, () => {
  console.log(`🚀 Servidor rodando em http://localhost:${PORTA}`);
});
