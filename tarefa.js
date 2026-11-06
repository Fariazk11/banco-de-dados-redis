// =============================================================
// tarefa.js — Inicia a tarefa pesada numa thread separada
// =============================================================

const path = require('path');
const { Worker } = require('worker_threads');

// Executa a análise completa no worker.
//  - aoReceber(mensagem): chamado a cada aviso de progresso do worker
//  - devolve { pronto, cancelar }:
//      pronto   → Promise com o resultado final
//      cancelar → interrompe a tarefa (ex.: o usuário fechou a página)
function executarTarefaPesada(aoReceber) {
  const worker = new Worker(path.join(__dirname, 'tarefa-worker.js'));

  const pronto = new Promise((resolve, reject) => {
    worker.on('message', (mensagem) => {
      aoReceber(mensagem);
      if (mensagem.tipo === 'fim') {
        resolve(mensagem.resultado);
        worker.terminate();
      }
    });
    worker.on('error', reject);
    worker.on('exit', (codigo) => {
      if (codigo !== 0) reject(new Error('Tarefa interrompida'));
    });
  });

  return { pronto, cancelar: () => worker.terminate() };
}

module.exports = { executarTarefaPesada };
