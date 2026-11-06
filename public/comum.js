// =============================================================
// comum.js — Funções usadas por todas as páginas
// =============================================================

// Formata um número como dinheiro: 1234.5 → "R$ 1.234,50"
function formatarMoeda(valor) {
  return valor.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

// Formata números inteiros: 14250 → "14.250"
function formatarNumero(valor) {
  return valor.toLocaleString('pt-BR');
}

// Formata um tempo em milissegundos: 0.4123 → "0,412 ms"
function formatarTempo(ms) {
  return ms.toLocaleString('pt-BR', { minimumFractionDigits: 3, maximumFractionDigits: 3 }) + ' ms';
}

// Hora atual no formato "14:05:32"
function horaAtual() {
  return new Date().toLocaleTimeString('pt-BR');
}

// Preenche as tabelas de resultado (por produto e por categoria).
function mostrarRelatorio(dados) {
  const corpoProdutos = document.querySelector('#tabela-produtos tbody');
  const corpoCategorias = document.querySelector('#tabela-categorias tbody');

  corpoProdutos.innerHTML = dados.porProduto
    .map(
      (linha) => `
      <tr>
        <td>${linha.produto}</td>
        <td>${linha.categoria}</td>
        <td class="numero">${formatarNumero(linha.quantidade)}</td>
        <td class="numero">${formatarMoeda(linha.total_vendido)}</td>
        <td class="numero">${formatarMoeda(linha.ticket_medio)}</td>
      </tr>`
    )
    .join('');

  corpoCategorias.innerHTML = dados.porCategoria
    .map(
      (linha) => `
      <tr>
        <td>${linha.categoria}</td>
        <td class="numero">${formatarNumero(linha.quantidade)}</td>
        <td class="numero">${formatarMoeda(linha.total_vendido)}</td>
      </tr>`
    )
    .join('');
}

// Adiciona um item no topo do histórico, mantendo só os últimos "limite" itens.
function adicionarAoHistorico(listaEl, html, limite = 15) {
  const vazio = listaEl.querySelector('.vazio');
  if (vazio) vazio.remove();

  const item = document.createElement('li');
  item.innerHTML = html;
  listaEl.prepend(item);

  while (listaEl.children.length > limite) {
    listaEl.lastElementChild.remove();
  }
}

// Mostra no cabeçalho se o Redis está ligado ou desligado.
async function atualizarStatusRedis() {
  const el = document.getElementById('status-redis');
  if (!el) return;
  try {
    const resposta = await fetch('/api/status');
    const { redis } = await resposta.json();
    el.className = 'status ' + (redis ? 'ligado' : 'desligado');
    el.innerHTML = `<span class="bolinha"></span>Redis ${redis ? 'conectado' : 'desligado'}`;
  } catch {
    el.className = 'status desligado';
    el.innerHTML = '<span class="bolinha"></span>Servidor fora do ar';
  }
}

atualizarStatusRedis();
setInterval(atualizarStatusRedis, 5000); // atualiza a cada 5 segundos
