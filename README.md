# 🟥 redis-demo — Redis como cache vs. consulta direta no banco

Projeto de demonstração para apresentação de faculdade. Ele mostra, na prática,
quanto o **Redis** acelera uma aplicação quando usado como **cache** de uma
consulta pesada ao banco de dados.

O cenário é uma lanchonete fictícia com **300.000 pedidos**. O relatório de
vendas (total e quantidade por produto e por categoria) é calculado com
`GROUP BY` e `ORDER BY` sobre a tabela inteira, sem índices, então demora
algumas centenas de milissegundos. Com o Redis, o resultado fica guardado
na memória e volta em cerca de 1 ms.

## 🧰 Tecnologias

| Parte          | Tecnologia                                     |
| -------------- | ---------------------------------------------- |
| Servidor       | Node.js + Express                              |
| Banco de dados | SQLite (`better-sqlite3`), que é só um arquivo |
| Cache          | Redis (`redis` / node-redis v4)                |
| Front-end      | HTML, CSS e JavaScript puro                    |

## 📁 Estrutura

```
redis-demo/
├── server.js           # Servidor Express e rotas da API
├── db.js               # Cria/popula o SQLite e executa o relatório
├── cache.js            # Conexão com o Redis
├── tarefa.js           # Inicia a tarefa pesada numa thread separada
├── tarefa-worker.js    # A tarefa pesada (análise anual, ~2 min no banco)
├── docker-compose.yml  # Sobe o Redis com Docker
└── public/
    ├── index.html      # Página inicial + comparação lado a lado
    ├── analise.html    # Tarefa pesada: corrida banco × Redis ao vivo
    ├── analise.js      # Lógica da página da tarefa pesada
    ├── sem-redis.html  # Consulta sempre no banco
    ├── com-redis.html  # Consulta usando o cache
    ├── comum.js        # Funções compartilhadas pelas páginas
    └── style.css       # Visual
```

## 🚀 Como rodar

Pré-requisitos: [Node.js](https://nodejs.org) 18 ou superior e
[Docker](https://www.docker.com) (só para o Redis).

```bash
# 1. Instalar as dependências
npm install

# 2. Subir o Redis (porta 6379)
docker compose up -d

# 3. Rodar o servidor
npm start          # ou: npm run dev  (reinicia sozinho ao salvar arquivos)
```

Abra **http://localhost:3000** no navegador.

> Na primeira execução o servidor cria o arquivo `lanchonete.db` e gera os
> 300 mil pedidos, o que leva cerca de 1 segundo. Nas próximas vezes ele
> reaproveita o arquivo. Para gerar dados novos, apague o `lanchonete.db`.

Para desligar o Redis: `docker compose down`.

## 🔌 Rotas da API

| Método | Rota             | O que faz                                                                         |
| ------ | ---------------- | --------------------------------------------------------------------------------- |
| GET    | `/api/sem-redis` | Executa o relatório direto no SQLite, **toda vez**.                               |
| GET    | `/api/com-redis` | Procura a chave `relatorio:vendas` no Redis. Se não achar, consulta o banco e salva por 60 s. |
| DELETE | `/api/cache`     | Apaga a chave do Redis (força um MISS na próxima consulta).                       |
| GET    | `/api/status`    | Informa se o Redis está conectado.                                                |

Formato da resposta:

```json
{
  "origem": "cache",
  "tempoMs": 1.02,
  "dados": { "porProduto": [ ... ], "porCategoria": [ ... ] }
}
```

O `tempoMs` é medido **no servidor** com `performance.now()`, então não inclui
o tempo de rede nem o de desenho da página.

## 🧠 Como funciona o cache (padrão *cache-aside*)

```
Pedido chega em /api/com-redis
        │
        ▼
 Está no Redis? ──── SIM (HIT) ───► devolve do cache  (~1 ms)
        │
       NÃO (MISS)
        ▼
 Consulta o SQLite (~350 ms) ─► salva no Redis por 60 s ─► devolve
```

## 🏋️ Tarefa pesada: análise anual completa (~2 minutos)

A página **Tarefa pesada** (`/analise.html`) é o ponto alto da demonstração.
Ela executa um relatório gerencial com **10 etapas e cerca de 4.200 consultas SQL**:
matriz produto × mês, faturamento acumulado dia a dia, produto campeão de cada dia,
média móvel, comparação com a semana anterior, vendas diárias por categoria etc.
Cada consulta percorre os 300 mil pedidos (são mais de **1 bilhão de linhas lidas**),
e o total leva **cerca de 2 minutos** no banco.

O que a página mostra, ao vivo, para cada lado da "corrida":

- um **cronômetro** grande;
- a **barra de progresso**, o número de consultas SQL e de linhas percorridas;
- a **lista de etapas**, marcando a que está rodando e o tempo de cada uma;
- um **terminal** com cada consulta que o banco executa e o resultado dela;
- no lado do Redis, os comandos `GET` / `SET` e o selo **HIT** ou **MISS**.

No fim aparecem o **placar** (quantas vezes o Redis foi mais rápido) e o
**resultado da análise** (KPIs, gráfico mensal, rankings), que é idêntico nos dois lados.

Detalhes técnicos:

- A tarefa roda numa **worker thread** (`tarefa-worker.js`), para não travar o servidor.
- O progresso chega ao navegador por **Server-Sent Events** (`GET /api/tarefa?modo=banco|redis`).
- O resultado fica no Redis na chave `relatorio:analise-anual` por **10 minutos**
  (`GET`/`DELETE /api/tarefa/cache` para ver o estado ou apagar).
- Se você fechar ou recarregar a página, a tarefa é cancelada no servidor.
- O tempo depende do computador: em um PC mais rápido ou mais lento, os
  "2 minutos" podem variar.

> ⚠️ A análise é **de propósito** feita do jeito ingênuo (milhares de consultas
> sem índice) para simular um relatório caro. Na vida real, índices e consultas
> melhores ajudariam, mas ler um resultado pronto da memória continua muito mais barato.

### Roteiro sugerido para a tarefa pesada

1. Abra **Tarefa pesada** e clique em **Limpar cache**.
2. Clique em **▶ Executar** em "Com Redis": é um **MISS**, então ele calcula tudo no
   banco (~2 min) e guarda no cache. Enquanto roda, comente o terminal e as etapas.
3. Clique em **🏁 Corrida**: o lado "Com Redis" termina em **poucos milissegundos (HIT)**,
   com todas as etapas riscadas ("não precisou"), enquanto o lado "Sem Redis" segue
   executando consulta por consulta durante ~2 minutos.
4. Mostre o **placar** no final.

> Dica: faça o passo 2 antes da apresentação começar. O cache dura 10 minutos
> (o tempo restante aparece no topo da página).

## 👀 Roteiro da demonstração (páginas simples)

1. **Página "Sem Redis"**: clique em *Consultar* várias vezes. O tempo fica
   sempre alto (centenas de ms), porque o banco refaz o trabalho todo a cada clique.
2. **Página "Com Redis"**: clique em *Consultar*.
   - A 1ª vez mostra **MISS (banco)** e um tempo parecido com o da página sem Redis.
   - Da 2ª em diante mostra **HIT (cache)** e um tempo de cerca de **1 ms**.
3. Clique em **Limpar cache** e consulte de novo: volta a ser **MISS**.
   O mesmo acontece sozinho depois de **60 segundos** (expiração da chave).
4. **Página inicial**: clique em **Rodar 10 vezes** para ver as médias, quantas
   vezes o Redis foi mais rápido e o gráfico de barras. A barra do Redis
   fica tão pequena que quase some.
5. **Redis desligado**: rode `docker compose stop` e tente a página "Com Redis".
   Ela mostra uma mensagem de erro amigável, e a página "Sem Redis" continua
   funcionando. Rode `docker compose start` e, em alguns segundos, o servidor
   reconecta sozinho.

## 💡 Pontos para discutir na apresentação

- **Por que é tão mais rápido?** O Redis guarda os dados na **memória RAM** e
  devolve um resultado pronto. O banco precisa ler 300 mil linhas, agrupar e
  ordenar a cada consulta.
- **Expiração (TTL)**: os dados em cache podem ficar desatualizados. Os 60
  segundos são um acordo entre velocidade e dados recentes.
- **Invalidação**: em um sistema real, quando um novo pedido é gravado,
  pode-se apagar a chave (como faz o botão *Limpar cache*).
- **Quando NÃO vale a pena**: dados que mudam o tempo todo ou consultas que
  já são rápidas.
- **Índices** também ajudam o banco, mas um relatório agregado continua mais
  caro que ler um valor pronto da memória.
