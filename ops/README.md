# PKB Ops — permits, inspections e acompanhamento de obra

Módulo operacional da PKB Homes (separado do orçamentador em `frontend/` +
`supabase/`). Objetivo: substituir a planilha *Permits Control* por um sistema
que **lê as fontes de verdade sozinho** (portais dos condados, e-mail,
Buildertrend), guarda o histórico como eventos e devolve dashboard, alertas e
automações (e-mail de revisão para o projetista, follow-up, disparos a
fornecedores).

```
ops/
  collectors/energov/   coletor dos portais Tyler EnerGov CSS (Marion; Citrus/Orange a confirmar)
  data/permits/         planilha Permits Control importada (CSV UTF-8)
  data/portal/<county>/ um JSON por permit, como o portal devolveu + bloco normalizado
```

## Coletor EnerGov (portais de condado)

Marion County usa Tyler EnerGov *Citizen Self Service*. A consulta é **pública**
(sem login) e expõe, por permit: status e datas, rodadas de submittal, itens de
review por departamento **com o comentário completo do revisor**, inspeções,
holds, contatos (contratante e subs), fees e sub-records. Só anexos, e-reviews
e eventos exigem ser contato no registro.

```bash
cd ops && npm install
node collectors/energov/collect.mjs --county marion BLDR-26-05-13402
node collectors/energov/collect.mjs --county marion --from-csv data/permits/permits_control_2026-09-25.csv
```

Saída em `data/portal/marion/<PERMIT>.json`:

- `raw` — as respostas JSON que o próprio portal carregou (por rota), para auditoria
- `permit` — o bloco normalizado que o resto do sistema usa:
  `submittals[]` (versão, datas), `reviewItems[]` (departamento, status, revisor,
  e-mail, prazo, comentário), `workflow[]`, `inspections[]`, `holds[]`,
  `contacts[]`, `feeSummary`, `subRecords[]`

O coletor dirige o portal de verdade num Chromium headless (Playwright) e captura
o JSON que a interface pede; não reimplementa as chamadas. Isso mantém o mesmo
caminho de um visitante humano e sobrevive a mudanças cosméticas de tela.

Variáveis opcionais: `CHROMIUM_PATH` (binário do Chromium), `HTTPS_PROXY`.

## Próximos passos (ordem)

1. Citrus e Orange: confirmar se também são EnerGov; se sim, só adicionar em `PORTALS`.
2. Modelo de dados (Supabase): `projects`, `permit_cases`, `submittals`,
   `review_items`, `inspections`, `holds`, `events` + regras/notificações.
3. Leitor de e-mail da caixa do bot (IMAP) → eventos (Sovereign, FDEP, Bailey, Buildertrend).
4. Regras: review "Requires Re-submit" → rascunho de e-mail ao projetista com as
   correções itemizadas → follow-up 48h até `submittals[+1]` aparecer.
5. Dashboard de KPI: dias por rodada (condado × projetista), causas de reprovação
   por departamento, permits parados, holds ativos.
6. Buildertrend (RPA com usuário `PKB Ops Bot`): daily log por checagem, job por contrato.
