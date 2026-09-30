# Kubrusly Basso Team — monitoramento de listings

Sistema **independente** (não usa nada da PKB): banco próprio (projeto Supabase da org
*Kubrusly Basso Team*, schema `kb`), caixas de e-mail próprias e secrets próprios
(`KB_*`, `LISTING_*`, `REPLIERS_*`). Está nesta pasta para poder virar um repositório
separado sem mudar nada — nenhum arquivo aqui importa código de fora de `kb-listings/`.

## O que ele faz

| Quando | O quê |
|---|---|
| **toda hora** | Lê as 2 caixas (Victor e Gabriel) **só leitura** — nunca marca, move ou apaga. Pega pedidos, confirmações, cancelamentos e feedback de showing (ShowingTime, BrokerBay, Aligned, ShowingAssist ou e-mail direto) dos **nossos** listings → `kb.showings` |
| 2 h após cada showing | E-mail ao corretor do comprador pedindo feedback (interesse, preço, o que impede uma oferta) e abrindo a porta para oferta. 1 follow-up após 48 h. A resposta volta pela tag `[Showing S-XXXXXX]` |
| quando chega feedback | Claude lê e classifica: interesse, visão de preço, **oferta esperada** → alerta imediato para `KB_ALERT_TO` |
| **todo dia, 7h** | Repliers: nossos listings (status, preço, pending/sold) + o mercado dos ZIPs onde temos imóvel (ativos, pending, vendidos em 180 dias) → sugestões de produto |
| **segunda, 8h** | Relatório semanal por imóvel: showings (vs. semana anterior), feedback, mudanças, e o mercado — o que entrou em pending e o que vendeu na semana, estoque, $/sf vs. semelhantes. HTML para e-mail + texto pronto para WhatsApp |

**Sugestões de produto** (`kb.suggestions`): por mercado, qual planta (quartos/banheiros), faixa
de metragem e faixa de preço giram mais rápido (DOM mediano, volume, sell-through), prêmio de
construção nova vs. usado, efeito de piscina e garagem 2+ no $/sf.

## Segurança do envio

Nada sai sem você ligar: `KB_SEND_ENABLED=true` libera os e-mails aos corretores; os
relatórios aos clientes exigem ainda `--send` (ou `KB_REPORT_AUTOSEND=true`). Até lá tudo fica
como rascunho em `kb.outbound_messages` / `kb.listing_reports`, e a prévia com todos os
relatórios + texto de WhatsApp vai para `KB_REPORT_PREVIEW_TO`.

## Colocar no ar

1. **Banco** — no projeto Supabase da Kubrusly Basso Team: pegue o *Project ID* e um *Access
   Token* da conta. GitHub → Settings → Secrets → `KB_SUPABASE_PROJECT_REF`,
   `KB_SUPABASE_ACCESS_TOKEN`. Depois: Actions → **Kubrusly Basso — listings** → Run workflow →
   `migrate` (cria o schema `kb`; não toca em nada que já exista no projeto).
2. **E-mails** (Victor e Gabriel) — em cada conta Google: ativar verificação em 2 etapas →
   *Senhas de app* → gerar uma. Secrets: `LISTING_MAIL1_USER/PASS`, `LISTING_MAIL2_USER/PASS`.
   Se algum domínio não for Google, informe o servidor IMAP em `LISTING_MAILn_HOST`.
   **Não mande senhas por chat** — só nos secrets.
3. **Repliers** — secret `REPLIERS_API_KEY`; variável `REPLIERS_AGENTS` (seu nome/ID e o do
   Gabriel como aparecem no MLS) ou `REPLIERS_OFFICE_ID`.
4. **Clientes** — `config/listings.example.json` mostra o formato (vendedor, e-mails, WhatsApp,
   idioma, área de mercado). Cole o JSON completo no secret `KB_LISTINGS_JSON`. Listings novos
   que a Repliers encontrar entram sozinhos; falta só completar o vendedor.
5. **Claude** (opcional) — `KB_ANTHROPIC_API_KEY` para ler feedback e escrever o parágrafo do relatório.
6. **Rodar** — Actions → Run workflow → `backfill` (lê 120 dias de e-mail + mercado) → `report`
   para ver o primeiro relatório (artefato `kb-listings-reports` + e-mail de prévia).
7. **Ligar envio** — variáveis `KB_SEND_ENABLED=true` e, quando aprovar o formato, `KB_REPORT_AUTOSEND=true`.

## Local

```bash
cd kb-listings && npm install && cp .env.example .env   # preencher
set -a; . ./.env; set +a
npm run migrate
node scripts/load_listings.mjs
python3 collectors/mail/collect_mail.py --days 30 --dry-run
node collectors/repliers/sync.mjs --dry-run
node rules/showing_feedback.mjs --dry-run
node reports/weekly_report.mjs --dry-run            # HTML em data/reports/<semana>/
npm test
```

Sem Repliers, o mercado também entra por CSV exportado do MLS: `node collectors/mls/import_csv.mjs arquivo.csv`,
ou mande o CSV por e-mail para uma das caixas com "MLS" no assunto.

## Estrutura

```
db/schema.sql                 schema kb (idempotente)
collectors/mail/              leitor IMAP (2 caixas) + parser de showings (+ testes)
collectors/repliers/sync.mjs  nossos listings + mercado via Repliers
collectors/mls/import_csv.mjs alternativa: export CSV do MLS
rules/showing_feedback.mjs    pedido de feedback, follow-up, leitura e alerta de oferta
analysis/market_insights.mjs  sugestões de produto (planta, metragem, preço, features)
reports/weekly_report.mjs     relatório semanal (e-mail + WhatsApp)
lib/                          banco, e-mail, Claude, Repliers, CSV, mercado, relatório
```

## Pendências

- **Amostras reais de e-mail** de showing (ShowingTime/BrokerBay) das duas caixas para afinar o
  parser — os padrões atuais são tolerantes, mas foram escritos sem exemplos reais.
- **WhatsApp**: hoje o texto sai pronto para colar. Envio automático exige número na WhatsApp
  Cloud API (Meta) e template aprovado.
- Dashboard web (hoje: e-mail de prévia + tabelas no Supabase).
