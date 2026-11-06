// =============================================================
// analise.js — Página da tarefa pesada (corrida banco × Redis)
// =============================================================

const LIMITE_LINHAS_TERMINAL = 150;

// Formata uma duração: 3.2 → "3,200 ms" | 45210 → "45,2 s" | 118400 → "1 min 58,4 s"
function formatarDuracao(ms) {
  if (ms < 1000) return formatarTempo(ms);
  const segundos = ms / 1000;
  if (segundos < 60) return segundos.toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + ' s';
  const minutos = Math.floor(segundos / 60);
  const resto = (segundos % 60).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  return `${minutos} min ${resto} s`;
}

// Cronômetro no formato "01:58,42"
function formatarCronometro(ms) {
  const min = String(Math.floor(ms / 60000)).padStart(2, '0');
  const seg = String(Math.floor((ms % 60000) / 1000)).padStart(2, '0');
  const cent = String(Math.floor((ms % 1000) / 10)).padStart(2, '0');
  return `${min}:${seg},${cent}`;
}

// Números grandes de forma legível: 1.234.567.890 → "1,23 bilhão"
function formatarGrande(n) {
  if (n >= 1e9) return (n / 1e9).toLocaleString('pt-BR', { maximumFractionDigits: 2 }) + ' bi';
  if (n >= 1e6) return (n / 1e6).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + ' mi';
  return formatarNumero(n);
}

// Evita que textos vindos do servidor sejam interpretados como HTML
function escapar(texto) {
  return String(texto).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// =============================================================
// Uma "pista" da corrida (Sem Redis ou Com Redis)
// =============================================================
function criarPista(modo) {
  const el = document.getElementById('pista-' + modo);
  const $ = (seletor) => el.querySelector(seletor);

  const botao = $('.botao-pista');
  const cronometro = $('.cronometro');
  const selo = $('.selo-estado');
  const barra = $('.progresso-pista .barra');
  const textoProgresso = $('.texto-progresso');
  const cConsultas = $('.c-consultas');
  const cLinhas = $('.c-linhas');
  const listaEtapas = $('.etapas');
  const terminal = $('.terminal');

  let rodando = false;
  let totalConsultas = 0;
  let linhasPorConsulta = 0;
  let etapas = [];

  // Estado lido pela animação da corrida
  let porcentagem = 0; // quanto da tarefa já foi feito (0 a 100)
  let tempoFinal = null; // tempo medido no servidor, quando terminar
  let origemFinal = null; // "banco" ou "cache"

  // ---------- Pequenas funções de desenho ----------
  function mudarSelo(texto, classe) {
    selo.textContent = texto;
    selo.className = 'selo-estado ' + (classe || '');
  }

  function escreverNoTerminal(html, classe = '') {
    const linha = document.createElement('div');
    linha.className = 't-linha ' + classe;
    linha.innerHTML = html;
    terminal.appendChild(linha);
    while (terminal.children.length > LIMITE_LINHAS_TERMINAL) terminal.firstElementChild.remove();
    terminal.scrollTop = terminal.scrollHeight;
  }

  function desenharEtapas(estadoInicial) {
    listaEtapas.innerHTML = etapas
      .map(
        (e, i) => `
        <li class="etapa ${estadoInicial}" data-i="${i}">
          <span class="icone"></span>
          <span class="nome">${escapar(e.titulo)}<small>${formatarNumero(e.consultas)} consultas</small></span>
          <span class="info">${estadoInicial === 'pulada' ? 'não precisou' : ''}</span>
        </li>`
      )
      .join('');
  }

  const etapaEl = (i) => listaEtapas.querySelector(`[data-i="${i}"]`);

  // ---------- Cronômetro (conta no navegador enquanto espera) ----------
  let inicio = 0;
  let animacao = null;
  function iniciarCronometro() {
    inicio = performance.now();
    const tick = () => {
      cronometro.textContent = formatarCronometro(performance.now() - inicio);
      animacao = requestAnimationFrame(tick);
    };
    tick();
  }
  function pararCronometro() {
    cancelAnimationFrame(animacao);
  }

  // ---------- Executa a tarefa e acompanha ao vivo ----------
  function executar() {
    if (rodando) return Promise.resolve(null);
    rodando = true;
    botao.disabled = true;
    porcentagem = 0;
    tempoFinal = null;
    origemFinal = null;

    // Limpa a pista
    terminal.innerHTML = '';
    cConsultas.textContent = '0';
    cLinhas.textContent = '0';
    barra.style.width = '0';
    textoProgresso.textContent = '—';
    cronometro.className = 'cronometro rodando';
    listaEtapas.innerHTML = '<li class="vazio">Iniciando...</li>';
    mudarSelo(modo === 'redis' ? 'Consultando o Redis...' : 'Consultando o banco...', 'trabalhando');
    escreverNoTerminal(`$ GET /api/tarefa?modo=${modo}`, 't-cinza');
    iniciarCronometro();

    return new Promise((resolve) => {
      // EventSource = conexão que fica aberta recebendo eventos do servidor
      const fonte = new EventSource('/api/tarefa?modo=' + modo);

      const terminar = (retorno) => {
        fonte.close();
        pararCronometro();
        rodando = false;
        botao.disabled = false;
        cronometro.classList.remove('rodando');
        resolve(retorno);
      };

      // Mensagens do Redis (GET, HIT, MISS, SET)
      fonte.addEventListener('log', (e) => {
        const { texto, tipo } = JSON.parse(e.data);
        const prefixo = tipo === 'redis' ? '<span class="t-redis">redis&gt;</span> ' : '';
        escreverNoTerminal(prefixo + escapar(texto), 't-' + tipo);
        if (tipo === 'miss') mudarSelo('MISS: calculando no banco...', 'miss');
      });

      // O banco começou: recebemos a lista de etapas
      fonte.addEventListener('inicio', (e) => {
        const dados = JSON.parse(e.data);
        totalConsultas = dados.totalConsultas;
        linhasPorConsulta = dados.linhasPorConsulta;
        etapas = dados.etapas;
        desenharEtapas('pendente');
        if (modo === 'banco') mudarSelo('Consultando o banco...', 'trabalhando');
        escreverNoTerminal(
          `<span class="t-banco">sqlite&gt;</span> ${formatarNumero(totalConsultas)} consultas a executar, ` +
            `cada uma lendo ${formatarNumero(linhasPorConsulta)} linhas`,
          't-amarelo'
        );
      });

      // Começou uma etapa: mostramos o SQL dela
      fonte.addEventListener('etapa', (e) => {
        const { indice, sql } = JSON.parse(e.data);
        etapaEl(indice).className = 'etapa andando';
        escreverNoTerminal(`▶ Etapa ${indice + 1}/${etapas.length}: ${escapar(etapas[indice].titulo)}`, 't-titulo');
        escreverNoTerminal(escapar(sql), 't-sql');
      });

      // Cada consulta executada pelo banco
      fonte.addEventListener('consulta', (e) => {
        const c = JSON.parse(e.data);
        const pct = (c.numero / totalConsultas) * 100;
        barra.style.width = pct + '%';
        textoProgresso.textContent = `${formatarNumero(c.numero)} de ${formatarNumero(totalConsultas)} consultas (${pct.toFixed(0)}%)`;
        cConsultas.textContent = formatarNumero(c.numero);
        porcentagem = pct;
        cLinhas.textContent = formatarGrande(c.numero * linhasPorConsulta);
        etapaEl(c.etapa).querySelector('.info').textContent = '⏳';
        escreverNoTerminal(
          `<span class="t-num">#${String(c.numero).padStart(4, '0')}</span> ${escapar(c.texto)} ` +
            `<span class="t-res">→ ${escapar(c.resumo)}</span> <span class="t-ms">${c.ms.toFixed(0)} ms</span>`
        );
      });

      // Terminou uma etapa
      fonte.addEventListener('etapa-fim', (e) => {
        const { indice, ms } = JSON.parse(e.data);
        const li = etapaEl(indice);
        li.className = 'etapa feita';
        li.querySelector('.info').textContent = formatarDuracao(ms);
      });

      // Fim! Mostra o tempo medido no servidor
      fonte.addEventListener('fim', (e) => {
        const dados = JSON.parse(e.data);
        cronometro.textContent = formatarDuracao(dados.tempoMs);
        porcentagem = 100;
        tempoFinal = dados.tempoMs;
        origemFinal = dados.origem;

        if (dados.origem === 'cache') {
          // HIT: nenhuma etapa precisou rodar
          etapas = dados.resultado.etapas || [];
          desenharEtapas('pulada');
          mudarSelo('HIT: veio pronto do cache', 'hit');
          barra.style.width = '100%';
          textoProgresso.textContent = '1 comando no Redis (GET) e nenhuma consulta ao banco';
        } else {
          mudarSelo(modo === 'redis' ? 'MISS: calculado e guardado no cache' : 'Concluído', modo === 'redis' ? 'miss' : 'feito');
        }
        escreverNoTerminal(`✔ Concluído em ${formatarDuracao(dados.tempoMs)}`, 't-ok');
        terminar(dados);
      });

      // Erro enviado pelo servidor (ex.: Redis desligado)
      fonte.addEventListener('erro', (e) => {
        const { erro } = JSON.parse(e.data);
        mudarSelo('Erro', 'erro');
        escreverNoTerminal('✖ ' + escapar(erro), 't-erro');
        cronometro.textContent = '—';
        terminar(null);
      });

      // Conexão caiu (servidor desligado, etc.). Fechamos para o navegador
      // NÃO reconectar sozinho (isso recomeçaria a tarefa de 2 minutos).
      fonte.onerror = () => {
        if (!rodando) return;
        mudarSelo('Erro', 'erro');
        escreverNoTerminal('✖ A conexão com o servidor foi interrompida.', 't-erro');
        terminar(null);
      };
    });
  }

  // Fotografia do estado atual (usada pela animação da corrida)
  function estado() {
    return {
      rodando,
      decorrido: rodando ? performance.now() - inicio : tempoFinal || 0,
      porcentagem,
      tempoFinal,
      origem: origemFinal,
    };
  }

  return { executar, botao, estado };
}

// =============================================================
// Página
// =============================================================
const pistaBanco = criarPista('banco');
const pistaRedis = criarPista('redis');
const ultimos = { banco: null, redis: null }; // último resultado de cada pista

const botaoCorrida = document.getElementById('botao-corrida');
const botaoLimpar = document.getElementById('botao-limpar');
const estadoCache = document.getElementById('estado-cache');
const dica = document.getElementById('dica');
const erroGeral = document.getElementById('erro-geral');

async function rodar(modo) {
  const pista = modo === 'banco' ? pistaBanco : pistaRedis;
  const dados = await pista.executar();
  if (dados) {
    ultimos[modo] = dados;
    mostrarResultado(dados.resultado);
    atualizarPlacar();
  }
  atualizarEstadoCache();
}

pistaBanco.botao.addEventListener('click', () => rodar('banco'));
pistaRedis.botao.addEventListener('click', () => rodar('redis'));

// Corrida: dispara as duas pistas ao mesmo tempo
botaoCorrida.addEventListener('click', async () => {
  botaoCorrida.disabled = true;
  await Promise.all([rodar('banco'), rodar('redis')]);
  botaoCorrida.disabled = false;
});

botaoLimpar.addEventListener('click', async () => {
  erroGeral.classList.add('oculto');
  const resposta = await fetch('/api/tarefa/cache', { method: 'DELETE' });
  if (!resposta.ok) {
    erroGeral.textContent = '🔌 ' + (await resposta.json()).erro;
    erroGeral.classList.remove('oculto');
  }
  atualizarEstadoCache();
});

// Mostra se o resultado está guardado no Redis e quanto tempo falta para expirar
async function atualizarEstadoCache() {
  try {
    const estado = await (await fetch('/api/tarefa/cache')).json();
    if (!estado.redis) {
      estadoCache.className = 'chip desligado';
      estadoCache.textContent = 'Redis desligado';
      dica.textContent = 'Ligue o Redis com "docker compose up -d". A pista "Sem Redis" continua funcionando.';
    } else if (estado.existe) {
      const min = Math.floor(estado.ttl / 60);
      const seg = String(estado.ttl % 60).padStart(2, '0');
      estadoCache.className = 'chip cheio';
      estadoCache.textContent = `Cache: resultado guardado (expira em ${min}:${seg})`;
      dica.textContent = 'O cache está pronto: na corrida, o Redis vai responder na hora (HIT) enquanto o banco calcula tudo.';
    } else {
      estadoCache.className = 'chip vazio';
      estadoCache.textContent = 'Cache: vazio';
      dica.textContent =
        'Dica: com o cache vazio, a primeira execução "Com Redis" também vai ao banco (MISS) e guarda o resultado. ' +
        'Rode-a uma vez e depois faça a corrida.';
    }
  } catch {
    estadoCache.className = 'chip desligado';
    estadoCache.textContent = 'Servidor fora do ar';
  }
}
atualizarEstadoCache();
setInterval(atualizarEstadoCache, 1000);

// Placar: aparece quando as duas pistas já rodaram pelo menos uma vez
function atualizarPlacar() {
  const { banco, redis } = ultimos;
  if (!banco || !redis) return;

  document.getElementById('placar').classList.remove('oculto');
  const vezes = banco.tempoMs / redis.tempoMs;
  const textoVezes = vezes >= 1.1
    ? `Com Redis foi <strong>${formatarNumero(Math.round(vezes))}x</strong> mais rápido`
    : 'Os dois levaram praticamente o mesmo tempo (o Redis teve um MISS e também foi ao banco)';
  document.getElementById('placar-destaque').innerHTML = textoVezes;
  document.getElementById('placar-banco').textContent = formatarDuracao(banco.tempoMs);
  document.getElementById('placar-redis').textContent =
    formatarDuracao(redis.tempoMs) + (redis.origem === 'cache' ? ' (HIT)' : ' (MISS)');

  const maior = Math.max(banco.tempoMs, redis.tempoMs);
  document.getElementById('placar-barra-banco').style.width = (banco.tempoMs / maior) * 100 + '%';
  document.getElementById('placar-barra-redis').style.width = (redis.tempoMs / maior) * 100 + '%';

  const total = banco.resultado.totalConsultas;
  const linhas = total * banco.resultado.linhasPorConsulta;
  document.getElementById('placar-detalhe').textContent =
    redis.origem === 'cache'
      ? `Sem Redis: ${formatarNumero(total)} consultas SQL e ${formatarGrande(linhas)} linhas percorridas. ` +
        'Com Redis: 1 comando GET, sem tocar no banco.'
      : 'Rode "Com Redis" de novo (ou a corrida) para ver o HIT.';
}

// Desenha o resultado da análise (é o mesmo, venha do banco ou do cache)
function mostrarResultado(r) {
  document.getElementById('resultado').classList.remove('oculto');

  const semana = new Date(r.melhorSemana.dia + 'T12:00:00').toLocaleDateString('pt-BR');
  document.getElementById('kpis').innerHTML = [
    ['Faturamento no ano', formatarMoeda(r.resumo.faturamento)],
    ['Pedidos', formatarNumero(r.resumo.pedidos)],
    ['Ticket médio', formatarMoeda(r.resumo.ticketMedio)],
    ['Melhor semana', `até ${semana}`, `${formatarMoeda(r.melhorSemana.media)} por dia`],
    ['Horário de pico', `${r.picos[0].dia}, ${r.picos[0].hora}`, `${formatarNumero(r.picos[0].quantidade)} pedidos`],
  ]
    .map(([rotulo, valor, extra]) => `
      <div class="cartao kpi"><span>${rotulo}</span><strong>${valor}</strong>${extra ? `<small>${extra}</small>` : ''}</div>`)
    .join('');

  // Gráfico de colunas do faturamento mensal (HTML/CSS puro)
  const maiorMes = Math.max(...r.porMes.map((m) => m.total));
  document.getElementById('grafico-meses').innerHTML = r.porMes
    .map((m) => {
      const [ano, mes] = m.mes.split('-');
      const nome = new Date(ano, mes - 1, 1).toLocaleDateString('pt-BR', { month: 'short' }).replace('.', '');
      const altura = (m.total / maiorMes) * 100;
      return `<div class="coluna" title="${m.mes}: ${formatarMoeda(m.total)}">
                <div class="valor-coluna" style="height:${altura}%"></div><span>${nome}/${ano.slice(2)}</span>
              </div>`;
    })
    .join('');

  document.getElementById('tabela-campeoes').innerHTML = r.rankingCampeoes
    .slice(0, 6)
    .map((c, i) => `<tr><td>${i + 1}º</td><td>${escapar(c.produto)}</td><td class="numero">${c.dias} dias</td></tr>`)
    .join('');

  document.getElementById('tabela-top').innerHTML = r.porProduto
    .slice(0, 6)
    .map((p, i) => `<tr><td>${i + 1}º</td><td>${escapar(p.produto)}</td><td class="numero">${formatarMoeda(p.total)}</td></tr>`)
    .join('');

  document.getElementById('tabela-picos').innerHTML = r.picos
    .map((p) => `<tr><td>${p.dia}</td><td>${p.hora}</td><td class="numero">${formatarNumero(p.quantidade)} pedidos</td></tr>`)
    .join('');
}

// =============================================================
// Comparação visual: pista de corrida + linha do tempo + contador
// =============================================================
// Um laço de animação (requestAnimationFrame, ~60 vezes por segundo)
// lê o estado das duas pistas e redesenha a parte visual.

const visual = {
  banco: {
    raia: document.getElementById('raia-banco'),
    corredor: document.querySelector('#raia-banco .corredor'),
    rastro: document.querySelector('#raia-banco .rastro'),
    tempo: document.querySelector('#raia-banco .raia-tempo'),
    medalha: document.querySelector('#raia-banco .medalha'),
    barra: document.getElementById('lt-barra-banco'),
    rotulo: document.getElementById('lt-rotulo-banco'),
  },
  redis: {
    raia: document.getElementById('raia-redis'),
    corredor: document.querySelector('#raia-redis .corredor'),
    rastro: document.querySelector('#raia-redis .rastro'),
    tempo: document.querySelector('#raia-redis .raia-tempo'),
    medalha: document.querySelector('#raia-redis .medalha'),
    barra: document.getElementById('lt-barra-redis'),
    rotulo: document.getElementById('lt-rotulo-redis'),
  },
};
const eixo = document.getElementById('lt-eixo');
const contadorBox = document.getElementById('contador-vezes');
const contadorNumero = document.getElementById('contador-numero');
const contadorTexto = document.getElementById('contador-texto');
const legendaCorrida = document.getElementById('legenda-corrida');

let eixoMaximo = 0; // fim da régua da linha do tempo, em ms

// Desenha a régua (0 s, 30 s, 1 min, ...) só quando a escala muda
function desenharEixo(maximo) {
  if (maximo === eixoMaximo) return;
  eixoMaximo = maximo;
  let marcas = '';
  // marcações de 30 s em réguas curtas; de 1 min em réguas longas (para não amontoar)
  const passo = maximo > 180000 ? 60000 : 30000;
  for (let ms = 0; ms <= maximo; ms += passo) {
    const rotulo = ms === 0 ? '0' : ms % 60000 === 0 ? `${ms / 60000} min` : `${Math.floor(ms / 60000) ? Math.floor(ms / 60000) + ' min ' : ''}30 s`;
    marcas += `<span style="left:${(ms / maximo) * 100}%">${rotulo}</span>`;
  }
  eixo.innerHTML = marcas;
  // a grade dos trilhos acompanha as marcações da régua
  document.querySelectorAll('.lt-trilho').forEach((t) => t.style.setProperty('--passo', (passo / maximo) * 100 + '%'));
}

function animarCorrida() {
  const estados = { banco: pistaBanco.estado(), redis: pistaRedis.estado() };
  const algumComecou = estados.banco.rodando || estados.banco.tempoFinal || estados.redis.rodando || estados.redis.tempoFinal;

  // 1) Pista de corrida: corredores andam conforme a porcentagem concluída
  for (const modo of ['banco', 'redis']) {
    const e = estados[modo];
    const v = visual[modo];
    // desconta a largura do corredor para ele parar ANTES da bandeira, e não atrás dela
    v.corredor.style.left = `calc(${e.porcentagem}% - ${(e.porcentagem / 100) * 40}px)`;
    v.rastro.style.width = e.porcentagem + '%';
    v.raia.classList.toggle('chegou', e.tempoFinal !== null);
    v.raia.classList.toggle('correndo', e.rodando);
    v.tempo.textContent =
      e.tempoFinal !== null ? formatarDuracao(e.tempoFinal) : e.rodando ? formatarCronometro(e.decorrido) : '—';
  }

  // Medalhas: quem terminou primeiro (menor tempo) ganha o ouro
  const terminados = ['banco', 'redis'].filter((m) => estados[m].tempoFinal !== null);
  const ordem = terminados.sort((a, b) => estados[a].tempoFinal - estados[b].tempoFinal);
  visual.banco.medalha.textContent = '';
  visual.redis.medalha.textContent = '';
  ordem.forEach((modo, i) => (visual[modo].medalha.textContent = i === 0 ? '🥇' : '🥈'));

  // 2) Linha do tempo em escala real (régua de pelo menos 2,5 minutos)
  const maiorTempo = Math.max(estados.banco.decorrido, estados.redis.decorrido);
  desenharEixo(Math.max(150000, Math.ceil((maiorTempo * 1.1) / 30000) * 30000));
  for (const modo of ['banco', 'redis']) {
    const e = estados[modo];
    const largura = (e.decorrido / eixoMaximo) * 100;
    visual[modo].barra.style.width = largura + '%';
    visual[modo].rotulo.textContent = e.decorrido ? formatarDuracao(e.decorrido) : '';
    // O texto fica logo depois do fim da barra (ou dentro dela, em branco, se a barra for longa)
    const dentro = largura > 75;
    visual[modo].rotulo.classList.toggle('dentro', dentro);
    visual[modo].rotulo.style.left = dentro ? `calc(${largura}% - 8px)` : `calc(${largura}% + 8px)`;
  }

  // 3) Contador: quantas vezes o Redis caberia no tempo do banco
  const r = estados.redis;
  const b = estados.banco;
  if (r.origem === 'cache' && r.tempoFinal && (b.rodando || b.tempoFinal)) {
    const vezes = Math.floor(b.decorrido / r.tempoFinal);
    contadorBox.classList.remove('oculto');
    contadorNumero.textContent = formatarNumero(vezes);
    contadorTexto.textContent = b.rodando
      ? 'vezes: é quantas vezes o Redis já poderia ter entregado este mesmo relatório enquanto o banco ainda está calculando…'
      : 'vezes: o Redis poderia ter entregado este relatório tudo isso de vezes no tempo que o banco levou para calcular uma vez só.';
  } else {
    contadorBox.classList.add('oculto');
  }

  // Legenda explicando o momento atual
  if (!algumComecou) {
    legendaCorrida.textContent = 'Clique em "Corrida" para ver os dois saindo juntos.';
  } else if (r.origem === 'cache' && b.rodando) {
    legendaCorrida.textContent = '🚀 O Redis já cruzou a linha de chegada. O banco ainda está fazendo consultas…';
  } else if (r.rodando && b.rodando) {
    legendaCorrida.textContent = 'Os dois estão no banco: o cache estava vazio (MISS), então o Redis também precisou calcular.';
  } else if (r.origem === 'cache' && b.tempoFinal !== null) {
    legendaCorrida.textContent = '🏆 Fim da corrida: o Redis entregou o resultado pronto, enquanto o banco teve que refazer todas as consultas.';
  } else {
    legendaCorrida.textContent = '';
  }

  requestAnimationFrame(animarCorrida);
}
requestAnimationFrame(animarCorrida);
