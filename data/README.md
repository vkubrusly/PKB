# `data/` — orçamentos reais importados

Cada subpasta é um orçamento real da PKB no **formato normalizado** que todo
importador (PDF, XLSX, Buildertrend) deve produzir:

```
<projeto>/
  project.json    org + project + estimate (metadados, UUIDs fixos → idempotente)
  estimate.csv    line_code,wbs_code,item_name,qty,unit,unit_cost
  seed_<x>.sql    SQL gerado (não editar à mão — sai do importador)
```

## Gerar o SQL a partir da pasta normalizada

```bash
node scripts/import_estimate.mjs data/sunny_affordable > data/sunny_affordable/seed_sunny_affordable.sql
```

O importador **reconcilia** a soma `qty × unit_cost` contra `estimate.total_expected`
e falha ruidosamente (comentário `WARNING` no SQL + log no stderr) se não bater.

## Carregar num Postgres local

```bash
psql "$DATABASE_URL" -f data/sunny_affordable/seed_sunny_affordable.sql
```

O SQL é idempotente: faz upsert do org/project/estimate pelos UUIDs fixos e
substitui as linhas do estimate por completo a cada execução.

---

## `sunny_affordable` — a primeira calibração real

Modelo **Sunny**, construído em **Marion Oaks (Marion County, FL)**, padrão
**Essential/affordable**. Fonte: `PKB_Homes__Estimate_Affordable_27012026`.

- **77 linhas**, total **$204.641,90** · 1.820 sf living / 2.344 sf total · $87,30/sf.
- Séptico (linha 11.1) → `sewer = septic`.
- **Validação:** as 22 categorias e as somas de cada uma batem **exatamente** com o
  PDF (0 divergências), confirmando que a estrutura WBS do sistema corresponde
  ao orçamento real que a PKB usa hoje.

### Pendências de dado (a confirmar com a PKB)
- **Água** não consta no orçamento (`water = null`). Marion Oaks costuma ser poço.
- **Wind zone / flood zone** não constam — necessários para validação de código FL.
- Linhas "bundled" (custo $0 porque embutido no item irmão): 3.4.2 Windows,
  6.2 drywall labor, 7.2 trim material, 8.2 paint labor, 9.2 counter top.
