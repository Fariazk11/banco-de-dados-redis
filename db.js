// =============================================================
// db.js — Tudo o que envolve o banco de dados SQLite
// =============================================================
// Usamos o SQLite porque ele é só um arquivo: não precisa
// instalar nem configurar nenhum servidor de banco de dados.

const path = require('path');
const Database = require('better-sqlite3');

// O banco fica no arquivo "lanchonete.db", na pasta do projeto.
const db = new Database(path.join(__dirname, 'lanchonete.db'));

// Quantidade de pedidos fictícios que vamos gerar.
const TOTAL_PEDIDOS = 300000;

// Cardápio da nossa lanchonete fictícia (produto, categoria e preço unitário).
const CARDAPIO = [
  { produto: 'X-Burguer', categoria: 'Lanches', preco: 18.9 },
  { produto: 'X-Salada', categoria: 'Lanches', preco: 20.9 },
  { produto: 'X-Bacon', categoria: 'Lanches', preco: 24.9 },
  { produto: 'X-Tudo', categoria: 'Lanches', preco: 29.9 },
  { produto: 'Misto Quente', categoria: 'Lanches', preco: 12.5 },
  { produto: 'Hot Dog', categoria: 'Lanches', preco: 14.0 },
  { produto: 'Batata Frita P', categoria: 'Porções', preco: 10.0 },
  { produto: 'Batata Frita G', categoria: 'Porções', preco: 18.0 },
  { produto: 'Onion Rings', categoria: 'Porções', preco: 16.5 },
  { produto: 'Nuggets', categoria: 'Porções', preco: 15.9 },
  { produto: 'Refrigerante Lata', categoria: 'Bebidas', preco: 6.0 },
  { produto: 'Suco Natural', categoria: 'Bebidas', preco: 9.0 },
  { produto: 'Água Mineral', categoria: 'Bebidas', preco: 4.0 },
  { produto: 'Milk Shake', categoria: 'Bebidas', preco: 16.0 },
  { produto: 'Café Expresso', categoria: 'Bebidas', preco: 5.5 },
  { produto: 'Sorvete', categoria: 'Sobremesas', preco: 8.0 },
  { produto: 'Brownie', categoria: 'Sobremesas', preco: 9.5 },
  { produto: 'Pudim', categoria: 'Sobremesas', preco: 7.5 },
  { produto: 'Açaí 300ml', categoria: 'Sobremesas', preco: 15.0 },
  { produto: 'Combo Família', categoria: 'Combos', preco: 79.9 },
  { produto: 'Combo Individual', categoria: 'Combos', preco: 32.9 },
];

// Gera uma data aleatória dentro dos últimos 365 dias, no formato "AAAA-MM-DD HH:MM:SS".
function dataAleatoria() {
  const agora = Date.now();
  const umAno = 365 * 24 * 60 * 60 * 1000;
  const data = new Date(agora - Math.random() * umAno);
  return data.toISOString().slice(0, 19).replace('T', ' ');
}

// Cria a tabela (se não existir) e popula com pedidos fictícios (se estiver vazia).
function prepararBanco() {
  // ATENÇÃO: de propósito NÃO criamos índices nas colunas produto/categoria.
  // Assim o banco precisa ler as 300 mil linhas a cada consulta,
  // o que deixa o relatório "pesado" e o ganho do cache bem visível.
  db.exec(`
    CREATE TABLE IF NOT EXISTS pedidos (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      produto   TEXT    NOT NULL,
      categoria TEXT    NOT NULL,
      valor     REAL    NOT NULL,
      data      TEXT    NOT NULL
    )
  `);

  const { total } = db.prepare('SELECT COUNT(*) AS total FROM pedidos').get();
  if (total > 0) {
    console.log(`📦 Banco já possui ${total.toLocaleString('pt-BR')} pedidos.`);
    return;
  }

  console.log(`⏳ Populando o banco com ${TOTAL_PEDIDOS.toLocaleString('pt-BR')} pedidos fictícios...`);
  const inicio = Date.now();

  const inserir = db.prepare(
    'INSERT INTO pedidos (produto, categoria, valor, data) VALUES (?, ?, ?, ?)'
  );

  // Uma transação faz todos os INSERTs de uma vez só (muito mais rápido).
  const inserirTodos = db.transaction(() => {
    for (let i = 0; i < TOTAL_PEDIDOS; i++) {
      const item = CARDAPIO[Math.floor(Math.random() * CARDAPIO.length)];
      const quantidade = 1 + Math.floor(Math.random() * 3); // de 1 a 3 unidades
      const valor = Math.round(item.preco * quantidade * 100) / 100;
      inserir.run(item.produto, item.categoria, valor, dataAleatoria());
    }
  });
  inserirTodos();

  console.log(`✅ Banco populado em ${((Date.now() - inicio) / 1000).toFixed(1)} s.`);
}

// Consultas "pesadas" do relatório de vendas (sem índices = leitura da tabela inteira).
const SQL_POR_PRODUTO = `
  SELECT categoria,
         produto,
         COUNT(*)                AS quantidade,
         ROUND(SUM(valor), 2)    AS total_vendido,
         ROUND(AVG(valor), 2)    AS ticket_medio
  FROM pedidos
  GROUP BY categoria, produto
  ORDER BY total_vendido DESC
`;

const SQL_POR_CATEGORIA = `
  SELECT categoria,
         COUNT(*)                AS quantidade,
         ROUND(SUM(valor), 2)    AS total_vendido
  FROM pedidos
  GROUP BY categoria
  ORDER BY total_vendido DESC
`;

// Executa o relatório completo direto no banco.
function gerarRelatorio() {
  return {
    porProduto: db.prepare(SQL_POR_PRODUTO).all(),
    porCategoria: db.prepare(SQL_POR_CATEGORIA).all(),
  };
}

module.exports = { prepararBanco, gerarRelatorio };
