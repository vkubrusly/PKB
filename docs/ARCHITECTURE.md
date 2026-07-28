# Arquitetura — Sistema de Orçamentos PKB

Documento vivo. Traduz a especificação (`ESPECIFICACAO_SISTEMA_ORCAMENTOS_PKB_v2.md`)
em decisões técnicas concretas e no mapa do modelo de dados. Atualizar a cada sprint.

---

## 1. Princípios de design

1. **WBS é lei.** As 22 categorias e sua numeração são **imutáveis** (Parte 2 da spec).
   O nível de especificação afeta *o material vinculado e o Unit Cost* de cada linha —
   **nunca** a estrutura. Modelamos o WBS como tabela de referência versionada em código
   (`wbs_nodes`), não como dado editável pelo usuário.
2. **Nunca inventar preço.** Toda linha de orçamento carrega a **origem do preço**
   (`price_source`: catálogo/cotação/web/obra_real/estimado). Dado pago (invoice) tem o
   maior peso na calibração (Fase 2).
3. **Nível de especificação é atributo do material, não da estrutura.** Um `material`
   tem `spec_level ∈ {essential, signature, luxury, any}`. Os 3 cenários de orçamento
   nascem de resolver, para cada nó do WBS, o material default daquele nível
   (`spec_level_options`).
4. **Tudo por fórmula, auditável.** `Total = QTY × Unit Cost`; sub-totais por nível do
   WBS. QTY aplica `waste_factor`. Aprovação congela uma versão imutável do estimate.
5. **Multi-tenant desde o início.** Toda tabela de negócio carrega `org_id` e é protegida
   por RLS (Supabase Auth). Tabelas de referência (WBS) são globais/read-only.

---

## 2. Camadas

```
┌─────────────────────────────────────────────────────────────┐
│ Frontend — React + Vite + TS                                 │
│  · Cadastros (fornecedores, materiais, county params)        │
│  · Criação de projeto + upload de plantas                    │
│  · Revisão editável do estimate + mix & match + delta pricing│
│  · Proposta comparativa / memorial / exports                 │
└───────────────┬─────────────────────────────────────────────┘
                │ supabase-js (PostgREST + Storage + Auth)
┌───────────────▼─────────────────────────────────────────────┐
│ Supabase                                                     │
│  · Postgres (schema em supabase/migrations)                  │
│  · Storage (plantas, invoices, fotos de material, exports)   │
│  · Auth (org multi-tenant + RLS)                             │
│  · Edge Functions → Claude API (takeoff, parsing, busca web) │
└───────────────┬─────────────────────────────────────────────┘
                │
┌───────────────▼─────────────────────────────────────────────┐
│ Claude API (via Edge Functions / serviço)                    │
│  · Agente de Takeoff (planta PDF → quantidades no WBS)       │
│  · Agente de Invoices (PDF/foto → invoice_items + preços)    │
│  · Agente de Preços (busca web: preço + foto + link + data)  │
│  · Value engineering / validação de código FL                │
└─────────────────────────────────────────────────────────────┘
```

Os agentes de IA rodam server-side (Edge Functions) para proteger a API key e
centralizar as regras da Parte 4 (§4.4 — nunca inventar preço, questionar
inconsistências, validar código FL).

---

## 3. Modelo de dados — mapa das tabelas

Grupos e sua correspondência com a Parte 5 da spec. Todas as tabelas de negócio
têm `id uuid pk`, `org_id`, `created_at`, `updated_at`.

### 3.1 Referência (global, read-only)
| Tabela | Papel |
|---|---|
| `wbs_nodes` | As 22 categorias + subcategorias, numeração imutável. Self-ref por `parent_code`. |

### 3.2 Catálogo & preços (Sprint 1 / 4)
| Tabela | Papel |
|---|---|
| `suppliers` | Fornecedores. |
| `supplier_quotes` | Cotações recebidas (cabeçalho). |
| `materials` | Material com `spec_level`, foto, marca, modelo, `fl_approval` (FL#), memorial. |
| `material_prices` | Histórico de preço por material: `source`, `price`, `quoted_at`, `link`. |
| `spec_levels` | Definição dos níveis e `$/sf` alvo por modelo/condado. |
| `spec_level_options` | (nó WBS × nível) → material default. Alimenta a geração dos 3 cenários. |

### 3.3 Projetos & estimativas (Sprint 2 / 3)
| Tabela | Papel |
|---|---|
| `projects` | condado, wind/flood zone, água, esgoto, contrato, nível inicial, ARV. |
| `project_files` | plantas e anexos (ponteiro para Storage). |
| `estimates` | versão, nível, status (draft/approved/superseded). |
| `estimate_items` | linha: nó WBS, material, supplier, qty, unit, unit_cost, waste_factor, origem_preco, flag_dúvida, is_allowance. |

### 3.4 Realidade paga & calibração (Fase 2 — Sprint 6)
| Tabela | Papel |
|---|---|
| `invoices` | `project_id` OPCIONAL, fornecedor, número, data, total, arquivo. |
| `invoice_items` | linha do invoice → nó WBS (sugerido/confirmado), material vinculado. |
| `actual_costs` | custo real consolidado por nó WBS/modelo/condado (calibração). |

### 3.5 Parâmetros, documentos & exports (Sprint 5)
| Tabela | Papel |
|---|---|
| `county_parameters` | impact/permit/connection fees, exigências por condado, fonte + data. |
| `spec_documents` | memoriais descritivos e propostas geradas. |
| `change_orders` | alterações pós-contrato com delta, baseline preservado. |
| `draw_schedules` | cronograma de desembolso por etapa. |
| `bt_costcode_map` | WBS PKB → Cost Code Buildertrend (mapa reutilizável). |
| `rfq_requests` | Fase 3 — RFQ por e-mail. |

### 3.6 Diagrama de relações (núcleo)

```
wbs_nodes ──< spec_level_options >── spec_levels
    │                 │
    │                 └── material_id ──> materials ──< material_prices
    │                                          │
estimate_items >── estimates >── projects      └──> suppliers
    │  └─ wbs_code                  │
    │                              < project_files
invoice_items >── invoices ────────┘ (project_id opcional)
    └─ wbs_code
```

---

## 4. Enums centrais

| Enum | Valores |
|---|---|
| `spec_level` | `essential · signature · luxury · any` |
| `price_source` | `catalog · quote · web · invoice · estimated` |
| `water_source` | `municipal · well` |
| `sewer_type` | `municipal · septic · septic_nitrogen` |
| `contract_type` | `fixed_price · cost_plus` |
| `estimate_status` | `draft · approved · superseded` |
| `unit` | `ea · sf · lf · cy · ls · hr · gal` (extensível) |

---

## 4.1 Geração de orçamento — dois motores (§3.5.2 / §4.1)

O fluxo **Novo Orçamento** (`frontend/src/pages/NewEstimatePage.tsx`) sobe um projeto
e gera a estimativa + take-off por um de dois motores:

1. **Paramétrico (modelo-base)** — `scripts/estimate_engine.mjs` (canônico, validado)
   e `frontend/src/lib/estimateEngine.ts` (espelho no app). Escala os custos de um
   modelo de referência (Sunny) pela área, linha a linha, usando uma **base de escala
   por linha** (`fixed` / `living` / `total`) em `data/*/quantity_model.json`. Roda no
   cliente, sem IA. Responde à *estimativa de custo*. Toda linha sai `needs_review`.
2. **Take-off por IA (plantas)** — `supabase/functions/takeoff/index.ts` (Edge Function
   Deno). Baixa as plantas do Storage, manda para a Claude API (`claude-opus-5`, tool
   `emit_takeoff` com schema estrito) e devolve **quantidades de material por WBS**.
   Responde ao *take-off de material*. Exige `ANTHROPIC_API_KEY`.

> Contagem real de material (blocos, sf de drywall) vem do caminho de IA ou de fatores
> de consumo da PKB; o motor paramétrico entrega **custo escalado**, não contagem.

## 5. Decisões em aberto (a confirmar com o time PKB)

- **Modelo-base:** `projects.base_model` é texto livre agora; virar tabela `models`
  quando o catálogo de modelos PKB estiver definido.
- **Unidades:** enum inicial cobre o comum da Flórida residencial; ampliar conforme o
  `Estimate_Safira.xlsx` real.
- **Storage buckets:** `plantas`, `invoices`, `material-photos`, `exports` — RLS por org.
- **Import do XLSX oficial:** o parser do `Estimate_Safira.xlsx` (Sprint 1) preenche
  `wbs_nodes` de leaf-items reais e serve de fixture para os 3 cenários.
