# Conectar a IA (Claude API)

Os recursos de IA do sistema rodam como **Supabase Edge Functions** que chamam a
Claude API. Ficam prontos no repo; para ligar, basta **uma chave** e o deploy.

## Passo único de configuração

```bash
# 1. Chave da Claude API (obtida em console.anthropic.com)
supabase secrets set ANTHROPIC_API_KEY=sk-ant-...

# 2. Deploy das funções
supabase functions deploy takeoff
supabase functions deploy price-search
supabase functions deploy product-detail

# 3. Bucket de plantas (para o take-off)
#    Crie o bucket "plantas" no Storage (privado) — o app sobe o PDF lá.
```

`SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY` já são injetados pela plataforma.

## As três funções de IA

| Função | O que faz | Sprint | Entrada |
|---|---|---|---|
| `takeoff` | Lê o PDF das plantas → quantidades de material por WBS | 2b | `{ plan_path, target }` |
| `price-search` | **Agente de Preços** — busca web nos sites dos fornecedores → preço + link + foto + data → grava em `material_prices (source=web)` | 4 | `{ material_id }` |
| `product-detail` | **Agente de Detalhamento** — gera memorial descritivo + specs + marca/modelo (+ nota de FL# no envelope) | 4 | `{ material_id }` |

Todas usam o modelo `claude-opus-5`. `price-search` e `product-detail` usam as
**server tools de web search/fetch** do Claude para confirmar preço e specs em
páginas reais (§4.4: nunca inventar — sempre com fonte, link e data).

## Como o app chama

- **Take-off:** wizard "Novo orçamento" → método "Take-off por IA" → sobe as plantas → `takeoff`.
- **Preço / Detalhamento:** tela **Materiais**, botões **"Preço IA"** e **"Detalhar IA"** por linha.

Se a chave/função não estiver configurada, o app mostra uma mensagem clara em vez de falhar.

## Regras dos agentes (§4.4)

- Nunca inventar preço: toda linha tem origem (`web` com link + data, `quote`, `invoice`, `estimado`).
- Materiais de envelope (janelas, portas externas, stucco, telhado, soffit/fascia) recebem
  nota de **Florida Product Approval (FL#)** compatível com a wind speed do site.
- Materiais voláteis (lumber, cobre) marcam data de cotação para validade do orçamento.
