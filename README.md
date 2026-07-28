# PKB Homes — Motor de Especificação e Orçamento Inteligente

Sistema de orçamentos de obra residencial (Flórida) que elimina o "orçamento por
achismo": todo preço por pé quadrado sai amarrado a um **nível de especificação**
detalhado — material, foto, fornecedor e memorial — e o sistema se retroalimenta
com custos reais, cotações e busca de preços na web.

> Especificação técnica completa: [`docs/ESPECIFICACAO_SISTEMA_ORCAMENTOS_PKB_v2.md`](docs/ESPECIFICACAO_SISTEMA_ORCAMENTOS_PKB_v2.md)

## Stack

| Camada | Tecnologia |
|---|---|
| Frontend | React + Vite + TypeScript |
| Backend / DB | Supabase (Postgres + Storage + Auth) |
| IA | Claude API (takeoff de plantas, parsing de invoices/cotações, busca web) |
| Exports | XLSX (padrão PKB + Buildertrend-ready), PDF (memorial, proposta comparativa) |

## Estrutura do repositório

```
docs/                      Especificação e documentos de arquitetura
supabase/
  config.toml             Config local da CLI (db + seed)
  migrations/             Schema versionado (Postgres) — Parte 5 da spec
  seed.sql                Dados-semente: 22 categorias WBS (numeração imutável)
data/                     Orçamentos reais importados (formato normalizado + SQL)
scripts/                  Importador de orçamentos (CSV normalizado → SQL)
frontend/                 App React (Vite + TS) — login, cadastros, projeto por WBS
```

## Modelo de dados (resumo)

O coração do sistema é o **WBS de 22 categorias com numeração imutável** (Parte 2).
Cada linha de orçamento (`estimate_items`) referencia um nó do WBS e um material do
catálogo, e o material carrega o **nível de especificação** (Essential / Signature /
Luxury). Ver [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) para o mapa completo das
tabelas e como elas se conectam ao roadmap.

## Roadmap (Parte 6)

| Sprint | Entrega | Status |
|---|---|---|
| 1 | Setup + cadastros + import do modelo XLSX | ✅ schema + seed + import da Sunny (real, validado) |
| 2 | App React: login + cadastros + projeto por WBS | ✅ auth, orgs/RLS, projetos, materiais, fornecedores, níveis |
| 3 | Motor de níveis: 3 cenários + mix & match + delta pricing | ⏳ |
| 4 | Agente de Preços (cotações + histórico + busca web) | ⏳ |
| 5 | Saídas: XLSX + Buildertrend-ready + Memorial + Proposta + Draw schedule | ⏳ |
| 6 | Fase 2: Agente de Invoices + custos reais + conciliação + calibração | ⏳ |
| 7 | Fase 3: RFQ automático por e-mail | ⏳ |

## Setup local (Supabase)

```bash
# 1. Instalar a CLI do Supabase (https://supabase.com/docs/guides/cli)
supabase start                 # sobe Postgres + Studio locais
supabase db reset              # aplica migrations/ e seed/ do zero
```

As migrations em `supabase/migrations/` são idempotentes na ordem numérica e o
`supabase/seed.sql` carrega os dados de referência (WBS + níveis).
