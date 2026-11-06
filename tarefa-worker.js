// =============================================================
// tarefa-worker.js — A "tarefa pesada": análise anual completa
// =============================================================
// Este arquivo roda numa THREAD SEPARADA (worker thread).
// Motivo: o better-sqlite3 é síncrono. Se a análise de ~2 minutos
// rodasse na thread principal, o servidor inteiro ficaria travado
// (nem a página com Redis conseguiria responder).
//
// A análise é feita de propósito do jeito "ingênuo": milhares de
// consultas pequenas, e cada uma percorre a tabela inteira (não há
// índices). É um exemplo exagerado, mas mostra bem o custo de pedir
// ao banco, várias e várias vezes, um trabalho que poderia ser
// guardado pronto num cache.

const path = require('path');
const { parentPort } = require('worker_threads');
const { performance } = require('perf_hooks');
const Database = require('better-sqlite3');

// Conexão própria, somente leitura (cada thread precisa da sua).
const db = new Database(path.join(__dirname, 'lanchonete.db'), { readonly: true });

const NOMES_DIAS = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
const real = (v) => 'R$ ' + (v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Envia uma mensagem para a thread principal (que repassa ao navegador).
const enviar = (mensagem) => parentPort.postMessage(mensagem);

// -------------------------------------------------------------
// 1) Contexto: quais produtos, categorias, meses e dias existem
// -------------------------------------------------------------
function montarContexto() {
  const { total } = db.prepare('SELECT COUNT(*) AS total FROM pedidos').get();
  const produtos = db.prepare('SELECT DISTINCT produto, categoria FROM pedidos ORDER BY categoria, produto').all();
  const categorias = [...new Set(produtos.map((p) => p.categoria))];
  const { inicio } = db.prepare('SELECT MIN(data) AS inicio FROM pedidos').get();

  // Lista dos 365 dias analisados, a partir do primeiro pedido.
  const dias = [];
  const d = new Date(inicio.slice(0, 10) + 'T00:00:00Z');
  for (let i = 0; i < 365; i++) {
    dias.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  const meses = [...new Set(dias.map((dia) => dia.slice(0, 7)))];

  return { totalLinhas: total, produtos, categorias, dias, meses };
}

// -------------------------------------------------------------
// 2) As etapas da análise. Cada etapa gera uma lista de consultas.
//    Cada consulta tem: sql, params, texto (para o log) e salvar()
//    (que guarda o resultado e devolve um resumo para o log).
// -------------------------------------------------------------
function montarEtapas(ctx, r) {
  return [
    {
      titulo: 'Visão geral do ano',
      descricao: 'Totais gerais, vendas por produto, por mês e horários de pico',
      consultas: () => [
        {
          texto: 'Resumo geral (total de pedidos e faturamento)',
          sql: 'SELECT COUNT(*) AS pedidos, SUM(valor) AS total FROM pedidos',
          params: [],
          salvar: ([l]) => {
            r.resumo = { pedidos: l.pedidos, faturamento: l.total, ticketMedio: l.total / l.pedidos };
            return `${l.pedidos.toLocaleString('pt-BR')} pedidos, ${real(l.total)}`;
          },
        },
        {
          texto: 'Vendas por produto (GROUP BY produto)',
          sql: `SELECT produto, categoria, COUNT(*) AS quantidade, SUM(valor) AS total
                FROM pedidos GROUP BY produto, categoria ORDER BY total DESC`,
          params: [],
          salvar: (linhas) => {
            r.porProduto = linhas;
            return `${linhas.length} produtos, campeão: ${linhas[0].produto}`;
          },
        },
        {
          texto: 'Vendas por mês (GROUP BY mês)',
          sql: `SELECT substr(data, 1, 7) AS mes, COUNT(*) AS quantidade, SUM(valor) AS total
                FROM pedidos GROUP BY mes ORDER BY mes`,
          params: [],
          salvar: (linhas) => {
            r.porMes = linhas;
            return `${linhas.length} meses`;
          },
        },
        {
          texto: 'Horários de pico (GROUP BY dia da semana, hora)',
          sql: `SELECT CAST(strftime('%w', data) AS INTEGER) AS dia_semana,
                       substr(data, 12, 2) AS hora, COUNT(*) AS quantidade
                FROM pedidos GROUP BY dia_semana, hora ORDER BY quantidade DESC LIMIT 5`,
          params: [],
          salvar: (linhas) => {
            r.picos = linhas.map((l) => ({ dia: NOMES_DIAS[l.dia_semana], hora: l.hora + 'h', quantidade: l.quantidade }));
            return `pico: ${r.picos[0].dia} às ${r.picos[0].hora}`;
          },
        },
      ],
    },
    {
      titulo: 'Matriz produto × mês',
      descricao: 'Quanto cada produto vendeu em cada mês (uma consulta por combinação)',
      consultas: () =>
        ctx.produtos.flatMap(({ produto }) =>
          ctx.meses.map((mes) => ({
            texto: `${produto} em ${mes}`,
            sql: `SELECT COUNT(*) AS quantidade, SUM(valor) AS total
                  FROM pedidos WHERE produto = ? AND substr(data, 1, 7) = ?`,
            params: [produto, mes],
            salvar: ([l]) => {
              r.matriz = r.matriz || {};
              r.matriz[produto] = r.matriz[produto] || {};
              r.matriz[produto][mes] = l.total || 0;
              return `${l.quantidade} pedidos, ${real(l.total)}`;
            },
          }))
        ),
    },
    {
      titulo: 'Faturamento acumulado dia a dia',
      descricao: 'Para cada dia, soma tudo o que foi vendido desde o início',
      consultas: () =>
        ctx.dias.map((dia) => ({
          texto: `Acumulado até ${dia}`,
          sql: 'SELECT SUM(valor) AS total FROM pedidos WHERE data <= ?',
          params: [dia + ' 23:59:59'],
          salvar: ([l]) => {
            (r.acumulado = r.acumulado || []).push({ dia, total: l.total || 0 });
            return real(l.total);
          },
        })),
    },
    {
      titulo: 'Produto campeão de cada dia',
      descricao: 'Para cada dia do ano, qual produto teve mais pedidos',
      consultas: () =>
        ctx.dias.map((dia) => ({
          texto: `Campeão de ${dia}`,
          sql: `SELECT produto, COUNT(*) AS quantidade FROM pedidos
                WHERE substr(data, 1, 10) = ? GROUP BY produto ORDER BY quantidade DESC LIMIT 1`,
          params: [dia],
          salvar: ([l]) => {
            if (!l) return 'sem vendas';
            (r.campeoes = r.campeoes || []).push({ dia, produto: l.produto, quantidade: l.quantidade });
            return `${l.produto} (${l.quantidade} pedidos)`;
          },
        })),
    },
    {
      titulo: 'Comparação com a semana anterior',
      descricao: 'Para cada dia, compara o faturamento com o mesmo dia 7 dias antes',
      consultas: () =>
        ctx.dias.map((dia) => {
          const antes = new Date(dia + 'T00:00:00Z');
          antes.setUTCDate(antes.getUTCDate() - 7);
          const diaAnterior = antes.toISOString().slice(0, 10);
          return {
            texto: `${dia} vs. ${diaAnterior}`,
            sql: `SELECT SUM(CASE WHEN substr(data, 1, 10) = ? THEN valor END) AS hoje,
                         SUM(CASE WHEN substr(data, 1, 10) = ? THEN valor END) AS antes
                  FROM pedidos`,
            params: [dia, diaAnterior],
            salvar: ([l]) => {
              if (!l.hoje || !l.antes) return 'sem base de comparação';
              const variacao = ((l.hoje - l.antes) / l.antes) * 100;
              (r.variacao = r.variacao || []).push({ dia, variacao });
              return `${variacao >= 0 ? '+' : ''}${variacao.toFixed(1)}%`;
            },
          };
        }),
    },
    {
      titulo: 'Média móvel de 7 dias',
      descricao: 'Faturamento médio dos 7 dias anteriores, para cada dia',
      consultas: () =>
        ctx.dias.map((dia) => {
          const inicio = new Date(dia + 'T00:00:00Z');
          inicio.setUTCDate(inicio.getUTCDate() - 6);
          const de = inicio.toISOString().slice(0, 10);
          return {
            texto: `Média de ${de} a ${dia}`,
            sql: 'SELECT SUM(valor) / 7.0 AS media FROM pedidos WHERE data >= ? AND data <= ?',
            params: [de, dia + ' 23:59:59'],
            salvar: ([l]) => {
              (r.mediaMovel = r.mediaMovel || []).push({ dia, media: l.media || 0 });
              return real(l.media) + '/dia';
            },
          };
        }),
    },
    {
      titulo: 'Ticket médio por produto e mês',
      descricao: 'Valor médio de cada pedido, por produto, em cada mês',
      consultas: () =>
        ctx.produtos.flatMap(({ produto }) =>
          ctx.meses.map((mes) => ({
            texto: `Ticket médio de ${produto} em ${mes}`,
            sql: 'SELECT AVG(valor) AS media FROM pedidos WHERE produto = ? AND substr(data, 1, 7) = ?',
            params: [produto, mes],
            salvar: ([l]) => {
              r.ticketMedio = r.ticketMedio || {};
              r.ticketMedio[produto] = r.ticketMedio[produto] || {};
              r.ticketMedio[produto][mes] = l.media || 0;
              return real(l.media);
            },
          }))
        ),
    },
    {
      titulo: 'Crescimento semanal por categoria',
      descricao: 'Faturamento de cada categoria em cada uma das 52 semanas',
      consultas: () =>
        ctx.categorias.flatMap((categoria) =>
          Array.from({ length: 52 }, (_, semana) => {
            const de = ctx.dias[semana * 7];
            const ate = ctx.dias[semana * 7 + 6];
            return {
              texto: `${categoria}, semana ${semana + 1}`,
              sql: 'SELECT SUM(valor) AS total FROM pedidos WHERE categoria = ? AND data >= ? AND data <= ?',
              params: [categoria, de, ate + ' 23:59:59'],
              salvar: ([l]) => {
                r.semanal = r.semanal || {};
                (r.semanal[categoria] = r.semanal[categoria] || []).push(l.total || 0);
                return real(l.total);
              },
            };
          })
        ),
    },
    {
      titulo: 'Produto × dia da semana',
      descricao: 'Para cada produto e dia da semana, o horário em que mais vende',
      consultas: () =>
        ctx.produtos.flatMap(({ produto }) =>
          NOMES_DIAS.map((nomeDia, numero) => ({
            texto: `${produto} às ${nomeDia.toLowerCase()}s`,
            sql: `SELECT substr(data, 12, 2) AS hora, COUNT(*) AS quantidade FROM pedidos
                  WHERE produto = ? AND strftime('%w', data) = ?
                  GROUP BY hora ORDER BY quantidade DESC LIMIT 1`,
            params: [produto, String(numero)],
            salvar: ([l]) => {
              if (!l) return 'sem vendas';
              (r.melhorHorario = r.melhorHorario || []).push({ produto, dia: nomeDia, hora: l.hora + 'h', quantidade: l.quantidade });
              return `melhor horário: ${l.hora}h (${l.quantidade} pedidos)`;
            },
          }))
        ),
    },
    {
      titulo: 'Vendas diárias por categoria',
      descricao: 'Para cada categoria e cada dia do ano, quanto foi vendido',
      consultas: () =>
        ctx.categorias.flatMap((categoria) =>
          ctx.dias.map((dia) => ({
            texto: `${categoria} em ${dia}`,
            sql: `SELECT COUNT(*) AS quantidade, SUM(valor) AS total
                  FROM pedidos WHERE categoria = ? AND substr(data, 1, 10) = ?`,
            params: [categoria, dia],
            salvar: ([l]) => {
              r.categoriaDia = r.categoriaDia || {};
              (r.categoriaDia[categoria] = r.categoriaDia[categoria] || []).push(l.total || 0);
              return `${l.quantidade} pedidos, ${real(l.total)}`;
            },
          }))
        ),
    },
  ];
}

// -------------------------------------------------------------
// 3) Executa tudo, avisando o progresso a cada consulta
// -------------------------------------------------------------
function executar() {
  const resultado = {};
  const ctx = montarContexto();
  const etapas = montarEtapas(ctx, resultado).map((e) => ({ ...e, lista: e.consultas() }));
  const totalConsultas = etapas.reduce((soma, e) => soma + e.lista.length, 0);

  // Avisa quais são as etapas e quantas consultas cada uma terá
  enviar({
    tipo: 'inicio',
    totalConsultas,
    linhasPorConsulta: ctx.totalLinhas,
    etapas: etapas.map((e) => ({ titulo: e.titulo, descricao: e.descricao, consultas: e.lista.length })),
  });

  const preparadas = new Map(); // reaproveita cada SQL já preparado
  let numero = 0;

  etapas.forEach((etapa, indice) => {
    const inicioEtapa = performance.now();
    enviar({ tipo: 'etapa', indice, sql: etapa.lista[0].sql.replace(/\s+/g, ' ').trim() });

    for (const consulta of etapa.lista) {
      if (!preparadas.has(consulta.sql)) preparadas.set(consulta.sql, db.prepare(consulta.sql));

      const inicio = performance.now();
      const linhas = preparadas.get(consulta.sql).all(...consulta.params); // ← aqui o banco trabalha
      const ms = performance.now() - inicio;

      const resumo = consulta.salvar(linhas);
      numero++;
      enviar({ tipo: 'consulta', numero, etapa: indice, texto: consulta.texto, resumo, ms });
    }

    enviar({ tipo: 'etapa-fim', indice, ms: performance.now() - inicioEtapa });
  });

  // Ranking: quantos dias cada produto foi o campeão
  const contagem = {};
  for (const c of resultado.campeoes) contagem[c.produto] = (contagem[c.produto] || 0) + 1;
  resultado.rankingCampeoes = Object.entries(contagem)
    .map(([produto, dias]) => ({ produto, dias }))
    .sort((a, b) => b.dias - a.dias);

  // Melhor semana (maior média móvel)
  resultado.melhorSemana = resultado.mediaMovel.reduce((a, b) => (b.media > a.media ? b : a));

  // Informações sobre o trabalho feito (usadas pela página)
  resultado.totalConsultas = totalConsultas;
  resultado.linhasPorConsulta = ctx.totalLinhas;
  resultado.etapas = etapas.map((e) => ({ titulo: e.titulo, consultas: e.lista.length }));
  enviar({ tipo: 'fim', resultado });
}

executar();
