# PKB Ops — arquitetura

Estado: **esboço para validação** (2026-09-25). Nada aqui é código ainda, exceto o
coletor de Marion em `collectors/energov/`.

## 1. Princípios

1. **PKB Ops é a fonte de verdade operacional.** Portais, e-mail e Buildertrend são
   *fontes* (lemos) ou *destinos* (escrevemos), nunca o lugar onde o estado mora.
   Se uma ponte quebrar, a operação continua; só a cópia atrasa.
2. **Tudo vira evento.** Cada mudança observada ("review v4 negado pelo Building
   Plans", "inspeção Framing aprovada", "contrato assinado") entra numa linha do
   tempo imutável. Estado atual = última leitura; KPI = leitura do histórico.
3. **Um motor, vários módulos.** Permits, Inspections, Contratos e Campo são
   configurações do mesmo esqueleto: *conector → evento → regra → ação*.
4. **A IA propõe, uma pessoa aprova** (no início). E-mails para projetista,
   fornecedores e cliente nascem como rascunho com botão "Enviar". Quando a taxa
   de edição cair, passamos regra a regra para envio automático.
5. **Portável.** Roda em Supabase + Node; segredos em `.env`; nada preso ao
   ambiente de desenvolvimento.

## 2. Visão geral

```
FONTES                         PKB OPS (Supabase + workers Node)                 DESTINOS
──────                         ─────────────────────────────────                 ────────
Portais EnerGov ──┐            ┌──────────┐   ┌────────┐   ┌───────┐   ┌───────┐  E-mail (Sovereign,
 (Marion, Citrus, Orange)      │ coletores├──▶│ eventos├──▶│ regras├──▶│ ações ├─▶ fornecedores, cliente)
E-mail do bot (IMAP) ─┤        └──────────┘   └────────┘   └───────┘   └───────┘  Buildertrend (RPA)
Buildertrend (notif.) ┤              ▲             │                        │      WhatsApp/SMS (fase 2)
Site (form. contrato) ┤              │             ▼                        ▼
App de campo (áudio/foto)            │        ┌──────────┐            ┌──────────┐
                                     └────────┤  estado  │◀───────────┤ dashboard│
                                              └──────────┘            └──────────┘
```

Três processos rodam de verdade:

| Processo | O que faz | Frequência |
|---|---|---|
| `collect` | lê portais, caixa do bot, notificações do Buildertrend; grava eventos novos | portais 1×/dia (06:00), e-mail a cada 15 min |
| `rules` | avalia regras sobre eventos novos; cria tarefas, rascunhos, notificações | após cada `collect` |
| `bridge` | executa ações aprovadas: envia e-mail, escreve Daily Log no Buildertrend | contínuo |

## 3. Módulos

### 3.1 Permits (fase 1)
Cobre da assinatura do contrato até o permit emitido, inclusive Septic (FDEP),
Civic Association (Citrus), turtle, impact fees, NOC.

- Entrada: coletor EnerGov (público), e-mail (Sovereign, FDEP/Shady, Bailey, condado), planilha (carga inicial).
- Estado por permit: status do portal + **"com quem está a bola"** (condado / projetista / PKB / owner / FDEP / turtle).
- Saídas: e-mail de correções ao projetista; follow-up 48 h; disparos a fornecedores por gatilho; Daily Log no Buildertrend a cada mudança.

### 3.2 Inspections (fase 1, mesmo coletor)
- Entrada: aba Inspections do portal (status, inspetor, datas, reinspection) + e-mail do condado.
- Saídas: aviso ao supervisor/sub de aprovado/reprovado com o comentário do inspetor; próximo passo sugerido pela sequência padrão; KPI de reprovação por tipo/inspetor/sub.

### 3.3 Contratos e novas obras (fase 2)
- Entrada: e-mail do formulário do site → `contracts` (rascunho); assinatura (DocuSign/PandaDoc ou PDF assinado por e-mail) → evento `contract.signed`.
- Saídas: follow-up até assinar; ao assinar: cria `job`, abre `permit_case`, cria Job no Buildertrend (RPA), emite 1st draw invoice.

### 3.4 Campo (fase 2)
- Entrada: supervisor manda áudio + fotos (app simples ou WhatsApp) por casa.
- IA transcreve, resume, sugere fase concluída; supervisor confirma com um toque.
- Saída: Daily Log + fotos no Buildertrend; evento `field.report`.

### 3.5 Obra completa e Financeiro (fase 3) — fora deste esboço.

## 4. Conectores

| Conector | Direção | Técnica | Credencial | Status |
|---|---|---|---|---|
| EnerGov Marion | ler | Playwright sobre a UI pública; captura o JSON do próprio portal | nenhuma | **validado** |
| EnerGov Citrus / Orange / Charlotte | ler | idem, se forem EnerGov | a confirmar | aguardando URLs |
| Caixa do bot (Gmail) | ler/enviar | IMAP + SMTP com senha de app | `BOT_EMAIL_PASSWORD` | aguardando variável |
| Buildertrend | ler notificações / escrever Daily Log, fotos, schedule | e-mails de notificação (ler); RPA com usuário `PKB Ops Bot` (escrever); API se liberarem | `BUILDERTREND_PASS` | usuário a criar |
| Site (formulário de contrato) | ler | e-mail que o formulário já dispara | — | fase 2 |
| Claude API | processar | ler comentários de revisão, classificar causas, rascunhar e-mails, transcrever áudio | `ANTHROPIC_API_KEY` | — |

Cada conector implementa a mesma interface: `pull(since) → Event[]` e, quando
escreve, `push(action) → Result`. Trocar RPA por API no Buildertrend não toca o
resto.

## 5. Modelo de dados (schema `ops` no mesmo Supabase)

Reaproveita `orgs` e `projects` do orçamentador (o `job` aponta para o `project`
quando existir orçamento).

```
jobs                 uma casa/obra. address, parcel, county, model, owner, company (PKB/Prime),
                     contract_value, signed_at, draws, bt_job_name, project_id (→ projects), status
job_contacts         projetista (Sovereign), survey (Bailey), septic (Shady), subs; e-mails p/ disparos

permit_cases         um processo por job e por tipo: building | septic | civic_assoc | turtle | impact_fees | noc | survey
                     county, portal_case_id, number, status_portal, status_ops, ball_with (county|designer|pkb|owner|fdep|turtle),
                     applied_at, issued_at, last_collected_at
submittals           rodadas: version, submitted_at, due_at, completed_at, status
review_items         por rodada e departamento: department, status, reviewer, reviewer_email, due_at, completed_at,
                     comments, cause_tags[] (IA: energy_calc, truss, digital_seal, site_plan, septic, ...)
inspections          number, type, status, requested_at, scheduled_at, actual_at, inspector, reinspection, passed, failed,
                     comments, cause_tags[]
holds                name, type, reason, comments, created_at, active

events               linha do tempo imutável: job_id, permit_case_id?, kind, source (energov|email|buildertrend|user|rule),
                     occurred_at, payload jsonb, dedupe_key unique
tasks                follow-ups: kind (email_designer|followup_48h|vendor_request|...), due_at, status, assignee, payload
outbound_messages    rascunhos e envios: channel (email|whatsapp|bt_daily_log), to, subject, body, status (draft|approved|sent|failed),
                     approved_by, sent_at, in_reply_to_event
vendor_requests      por job: type (survey|stakeout|septic_design|noc|power|water|dumpster...), trigger_event, sent_at, done_at
contracts            fase 2: source_email, client, lot, model, value, status (requested|drafted|sent|signed), signed_at, job_id
field_reports        fase 2: job_id, supervisor, audio_path, photos[], transcript, summary, suggested_phase, confirmed
collector_runs       auditoria: connector, started_at, finished_at, items, errors
rules                regras ativas e modo (draft|auto) por regra
```

Chaves de idempotência: `events.dedupe_key` (ex.: `energov:review_item:<ItemReviewId>:<status>`),
`submittals(permit_case_id, version)`, `inspections(permit_case_id, number)`.

## 6. Regras v1 (todas começam em modo *rascunho*)

| # | Gatilho | Ação |
|---|---|---|
| R1 | `review_item.status = Requires Re-submit` novo | rascunho de e-mail ao projetista com as correções itemizadas (do comentário do revisor); `ball_with = designer`; tarefa follow-up +48 h |
| R2 | tarefa follow-up vence e não há `submittal` nova | novo follow-up ao projetista; a cada 2 ciclos escala para `OPS_NOTIFY_EMAIL` |
| R3 | `submittal` nova aparece | fecha follow-ups; `ball_with = county`; Daily Log "Resubmitted v{n}" |
| R4 | `permit_case.status → Issued` | evento `permit.issued`; dispara `vendor_requests` configurados para "após emissão"; Daily Log |
| R5 | `hold.active = true` novo | alerta imediato (e-mail) com o motivo; `ball_with = pkb` |
| R6 | `permit_case` sem evento há N dias (N por status) | alerta "parado" no dashboard e resumo semanal |
| R7 | `inspection.failed` novo | aviso ao supervisor + sub responsável com comentário; tarefa "reagendar"; Daily Log |
| R8 | `inspection.passed` novo | aviso ao supervisor com o próximo passo da sequência; Daily Log |
| R9 | qualquer mudança em permit/inspection | Daily Log no Buildertrend com o texto da mudança (uma entrada por dia por job) |
| R10 | e-mail do formulário do site (fase 2) | cria `contract` rascunho; tarefa para Guilherme; follow-up até `signed` |

## 7. Dashboard (telas v1)

1. **Hoje** — exceções: holds ativos, reviews negados sem resposta, follow-ups vencidos, inspeções reprovadas, permits parados. Cada linha com botão de ação (aprovar rascunho, marcar resolvido).
2. **Permits** — a planilha, viva: uma linha por job, colunas por processo (BP, Septic, Civic, Turtle...), "bola com", dias no estado. Filtros por condado/empresa/responsável.
3. **Permit** — a linha do tempo de um job: rodadas, comentários por departamento, e-mails enviados, inspeções, holds.
4. **KPIs** — dias applied→issued por condado/modelo/projetista; dias condado × resubmissão; causas de reprovação por departamento; taxa de reprovação de inspeção por tipo/inspetor/sub; tendência mensal.
5. **Caixa de saída** — rascunhos aguardando aprovação; histórico de envios.
6. **Configurações** — contatos por job, gatilhos de fornecedores, modo de cada regra, sequência padrão de inspeções por condado.

## 8. Fases e o que precisamos de você em cada uma

| Fase | Entrega | Precisamos de |
|---|---|---|
| 0 (agora) | estrutura, schema, coletor Marion, carga da planilha | validar este documento |
| 1 | Permits + Inspections em Marion: eventos, R1–R9 em rascunho, Daily Log via RPA, dashboard telas 1–4 | URLs Citrus/Orange; usuário Buildertrend do bot; senha da caixa do bot; e-mail da Sovereign; lista de disparos a fornecedores com gatilhos |
| 2 | Contratos (R10) + Campo (áudio/foto) | como o site envia o pedido; ferramenta de assinatura; modelo de contrato; quem são os supervisores e que celular usam |
| 3 | Obra completa + Financeiro | conversa separada |

## 9. Decisões em aberto

1. Canal de aviso da equipe: e-mail só, ou WhatsApp/SMS já na fase 1? (Proposta: e-mail na fase 1; WhatsApp na 2.)
2. Prime e PKB no mesmo dashboard com filtro por empresa? (Proposta: sim; o portal já traz o contratante.)
3. Onde hospedar os workers: Supabase Edge Functions + cron, ou um servidor Node de vocês? (Proposta: servidor Node com `pm2`, porque o RPA do Buildertrend precisa de Chromium.)
4. Quem aprova os rascunhos na fase 1: você, Guilherme, ou ambos?
