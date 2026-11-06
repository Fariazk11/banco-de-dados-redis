// =============================================================
// cache.js — Conexão com o Redis (nosso cache em memória)
// =============================================================

const { createClient } = require('redis');

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

const redis = createClient({
  url: REDIS_URL,
  // Se o Redis estiver desligado, os comandos falham na hora
  // (em vez de ficarem esperando numa fila até ele voltar).
  disableOfflineQueue: true,
  socket: {
    connectTimeout: 2000,
    // Se cair ou não conectar, tenta de novo a cada 3 segundos.
    // Assim dá para ligar o Redis com o servidor já rodando.
    reconnectStrategy: () => 3000,
  },
});

// Evita encher o terminal com a mesma mensagem de erro a cada tentativa.
let avisado = false;

redis.on('error', () => {
  if (!avisado) {
    console.warn(`⚠️  Redis indisponível em ${REDIS_URL}. Tentando reconectar a cada 3 s...`);
    avisado = true;
  }
});

redis.on('ready', () => {
  avisado = false;
  console.log(`🟥 Conectado ao Redis em ${REDIS_URL}`);
});

// Inicia a conexão sem travar o servidor caso o Redis esteja desligado.
function conectarRedis() {
  redis.connect().catch(() => {});
}

// Diz se o Redis está pronto para receber comandos.
function redisDisponivel() {
  return redis.isReady;
}

module.exports = { redis, conectarRedis, redisDisponivel };
