# Sistema de Orçamentos de Obra — PKB Homes
## Especificação Técnica v2.0 — "Motor de Especificação e Orçamento Inteligente"

**Missão:** Eliminar o orçamento por achismo. Todo preço por pé quadrado sai amarrado a um nível de especificação detalhado, com material, foto, fornecedor e memorial. O sistema une todas as demandas de um orçamentista de construção residencial na Flórida, e se retroalimenta com custos reais, cotações de fornecedores e busca de preços na web.

**Stack:** Claude Code · React (frontend) · Supabase (Postgres + Storage + Auth) · Claude API (leitura de projetos, busca web, parsing de cotações) · Export XLSX/PDF.

---

# PARTE 1 — O CORAÇÃO COMERCIAL: Motor de Níveis de Especificação

## 1.1 O problema que resolve
Hoje o preço varia de $165 a $250/sf sem que exista um detalhamento do que cada valor entrega. O sistema resolve isso com **níveis de especificação padronizados**: pacotes completos de materiais e acabamentos, pré-definidos e precificados, aplicáveis a qualquer projeto.

## 1.2 Níveis padrão PKB (configuráveis)
| Nível | Posicionamento | Exemplo de $/sf alvo* |
|---|---|---|
| **Essential** | Entrada / investidor / aluguel | ~$165–180/sf |
| **Signature** | Padrão PKB / cliente final | ~$200–225/sf |
| **Luxury** | Alto padrão / custom | ~$245–280/sf |
*Valores calibrados automaticamente pelo histórico real (Fase 2) por modelo e condado.

## 1.3 Como funciona
1. Cada categoria de material do WBS tem **opções cadastradas por nível** (ex.: Flooring → Essential: vinyl builder-grade · Signature: luxury vinyl + porcelanato nas áreas molhadas · Luxury: porcelanato retificado em toda a casa + porcelanato importado nos banhos).
2. Cada opção tem: foto, marca/modelo, specs, fornecedor preferencial, preço vigente (com fonte e data).
3. **Ao subir um projeto, o sistema gera automaticamente os 3 cenários de orçamento**, cada um com total, $/sf e memorial descritivo próprio.
4. **Mix & match:** o cliente pode escolher cozinha Luxury com o resto Signature — o sistema recalcula na hora e mostra o delta de cada troca ("upgrade de bancada: +$4.850").
5. **Delta pricing como ferramenta de venda:** toda troca de material exibe a diferença de preço — transforma upgrade em conversa objetiva e transparente.

## 1.4 Saída comercial
**Proposta Comparativa (PDF, PT/EN):** tabela lado a lado dos 3 níveis com fotos dos principais acabamentos, total e $/sf de cada um, e lista do que muda entre níveis. É o documento que o time comercial usa na mesa com o cliente — a resposta definitiva para "por que $220 e não $165?".

---

# PARTE 2 — Padrão de Orçamento PKB (formato oficial)

Estrutura idêntica ao `Estimate_Safira.xlsx` (modelo em uso):

**Cabeçalho:** PRIME KUBRUSLY BASSO HOMES · ESTIMATE - MODEL {nome} · aba = mercado/condado · Living Area (sf) · Total Area (sf) · $/Total area (fórmula).

**Colunas:** `COD | Item Name | QTY | Unit | Unit Cost | Total` — Total sempre por fórmula (QTY × Unit Cost), sub-totais por fórmula em cada nível do WBS.

**WBS — 22 categorias padrão (numeração imutável):**
```
1 Planning & Preconstruction (1.1 General Conditions · 1.2 Architect/
  Engineering · 1.3 Recurring Fixed Costs)
2 Site Work · 3 Shell Construction Structure (3.1 Slab · 3.2 Wall ·
  3.3 Framing · 3.4 Windows/Ext Doors · 3.5 Stucco · 3.6 Roofing ·
  3.7 Soffit/Fascia)
4 M.P.E.G. (4.1 HVAC · 4.2 Plumbing · 4.3 Electrical)
5 Insulation · 6 Drywall · 7 Interior Doors/Trims · 8 Paint
9 Cabinetry/Counter Top · 10 Hardware · 11 Sewer/Water Treatment
12 Flooring · 13 Garage Door · 14 Appliances · 15 Final Grading
16 Driveway · 17 Irrigation · 18 Landscaping · 19 Clean-Up
20 Punch List/Contingency · 21 Administration Fee · 22 Upgrades
```
Itens novos entram com o próximo código sequencial dentro da categoria. Os níveis de especificação afetam o **Unit Cost e o material vinculado** de cada linha — nunca a estrutura.

---

# PARTE 3 — Demandas do Orçamentista na Flórida (análise completa)

## 3.1 Regulatório e código de obra
- **Florida Building Code / wind zones:** velocidade de vento do site determina especificação de janelas, portas, shingle e engenharia de trusses. O sistema registra a wind speed do projeto e valida se os produtos escolhidos têm **Florida Product Approval** compatível (campo FL# no cadastro de materiais de envelope).
- **Energy Code:** insulação mínima, SEER do HVAC, eficiência de janelas (U-factor/SHGC) — o nível Essential nunca pode especificar abaixo do código.
- **Flood zone (FEMA):** zona do lote → exigência de elevação do pad → impacto direto em fill dirt (linha 2.2) e fundação. Campo obrigatório na criação do projeto.
- **Séptico:** convencional vs. sistema de redução de nitrogênio (áreas BMAP) vs. ligação de esgoto — diferença que pode passar de 2x no custo da linha 11.1. Alerta automático por localização.
- **Soil/Geo test:** exigência e custo por região (linha 3.1.3).

## 3.2 Parâmetros por condado (`county_parameters`)
Impact fees (escola/estrada/parques) · permit fees · water/sewer connection fees · power connection por concessionária · exigências específicas (ex.: Marion County vs. Lake County) · prazos médios de permit (informativo para o comercial). Atualização via busca web com fonte + data de verificação, refinada pelos custos reais.

## 3.3 Inteligência de custos
- **Custos de mão de obra por região:** labor rates separados de material onde relevante, com histórico por condado.
- **Fatores de perda (waste factors):** % configurável por material (block, drywall, tile, lumber) aplicado automaticamente no QTY.
- **Volatilidade:** materiais voláteis (lumber, cobre) marcados com data de cotação e validade do orçamento (padrão 30 dias, configurável) — orçamento vencido exige re-verificação de preços antes de virar contrato.
- **Contingência e markup configuráveis:** linhas 20 e 21 parametrizadas (% sobre custo direto), com política por tipo de contrato (fixed price vs. cost plus).
- **Value engineering:** a IA sugere alternativas de economia com impacto calculado ("trocar porcelanato X pelo Y: −$3.200, mesmo padrão visual").

## 3.4 Financeiro e comercial (integração com o mundo real da PKB)
- **Draw schedule:** geração automática do cronograma de desembolso por etapa (padrão bancos de construction loan: slab, lintel, dry-in, etc.) a partir do orçamento — essencial para clientes financiados.
- **Custo × valor de mercado:** campo para valor estimado de venda (ARV/CMA da Kubrusly & Basso) → margem projetada do projeto por nível de especificação. Une o chapéu de builder com o de broker: mostra em qual nível de acabamento o projeto maximiza retorno naquele bairro.
- **Change orders:** alterações pós-contrato geram documento de change order com delta de preço, mantendo o orçamento original como baseline.
- **Allowances:** itens ainda não definidos pelo cliente entram como allowance com valor de referência do nível escolhido, claramente marcados no memorial.

## 3.5 Fluxo do projeto
1. **Criação:** nome, modelo-base, condado, endereço, wind zone, flood zone, água (municipal/poço), esgoto (municipal/séptico/séptico-nitrogênio), tipo de contrato, nível de especificação inicial.
2. **Upload das plantas (PDF)** → Agente de Takeoff: extrai áreas, ambientes, quantidades; mapeia tudo no WBS; marca dúvidas com ⚠️ e registra sugestões.
3. **Geração dos 3 cenários** (Essential/Signature/Luxury) com preços do catálogo.
4. **Revisão editável:** trocar material (catálogo + busca web com foto), trocar fornecedor, ajustar QTY, aceitar sugestões, mix & match entre níveis.
5. **Aprovação → versão imutável** com auditoria de alterações.
6. **Saídas:** XLSX padrão PKB · **Export Buildertrend-ready** (Excel plano no layout do importador de Estimates do Buildertrend: Cost Code, Description, Quantity, Unit, Unit Cost, Cost Type, Markup — com tabela de mapeamento configurável WBS PKB → Cost Codes do Buildertrend, cadastrada uma vez e reutilizada em todo export) · Memorial Descritivo PDF (versão cliente sem preços / interna com preços, PT/EN) · Proposta Comparativa de níveis · Draw schedule · Resumo executivo com comparação ao histórico do modelo/condado.

---

# PARTE 4 — IA Auto-alimentada (o sistema que aprende)

## 4.1 Fontes de aprendizado contínuo
| Fonte | O que alimenta |
|---|---|
| Cotações de fornecedores (upload manual ou e-mail na Fase 3) | `supplier_quotes` + `material_prices` |
| Busca web nos sites dos fornecedores | preço vigente + foto + link, com data |
| **Invoices pagos durante a obra (PDF/foto)** | fonte de maior confiabilidade: preço real pago, fornecedor, material e serviço, linha por linha |
| Relatórios de obras executadas (exports Excel do Job Costing Budget do Buildertrend, exports de bills do QuickBooks, ou CSV genérico) | `actual_costs` → calibração |
| Plantas executadas | padrões de quantidade por modelo (ex.: sf de drywall por sf de casa) |
| Correções manuais do usuário | ajuste dos padrões de takeoff |

## 4.2 Agente de Invoices (Fase 2 — fonte prioritária)
1. Upload do invoice em PDF ou foto. **Campo opcional:** vincular à obra/planta da casa (projeto/modelo) — se informado, alimenta a conciliação daquele projeto; se não, o invoice entra como dado avulso e alimenta apenas o histórico de preços e fornecedores.
2. A IA extrai: fornecedor, data, número do invoice, e **cada linha** (descrição do serviço/material, quantidade, unidade, preço unitário, total).
3. Mapeamento automático de cada linha no WBS padrão (com sugestão para revisão quando ambíguo) e vínculo ao material do catálogo — se o material não existir, o agente propõe o cadastro já preenchido.
4. Grava em `invoice_items` e alimenta `material_prices` com fonte "invoice" (peso máximo na calibração — dado pago vale mais que cotação ou preço de site).
5. Fornecedor novo detectado → sugestão de cadastro automático em `suppliers`.
6. **Conciliação tripla por projeto:** orçado × cotado × pago, linha a linha — mostra onde o orçamento errou, onde o fornecedor subiu preço, e a evolução de preço de cada material ao longo do tempo.

## 4.3 Motor de calibração (Fase 2)
- Concilia custo real × orçado por linha do WBS, por modelo e por condado.
- Atualiza preços de referência com média ponderada por recência.
- Recalibra os $/sf alvo de cada nível de especificação automaticamente.
- Sinaliza fornecedores com desvio recorrente e materiais com tendência de alta.
- Dashboard: orçado × realizado, precisão do sistema ao longo do tempo (meta: desvio < 5%).

## 4.4 Regras do agente
- Nunca inventar preço: toda linha tem fonte (cotação / histórico / web com link / "estimado — confirmar").
- Questionar inconsistências com o padrão do modelo-base e do nível escolhido.
- Destacar desvios > 10% vs. média histórica por categoria.
- Validar código: envelope com FL Product Approval, energia, séptico conforme região.

---

# PARTE 5 — Modelo de Dados (Supabase)

```
suppliers · supplier_quotes · materials (com spec_level: essential |
signature | luxury | any, foto, marca, modelo, FL#, descrição memorial)
material_prices (fonte: cotação|web|obra_real, data, link)
spec_levels (definição dos níveis e $/sf alvo por modelo/condado)
spec_level_options (categoria WBS × nível → material default)
projects (condado, wind_zone, flood_zone, água, esgoto, contrato, nível)
project_files · estimates (versão, nível, status) · estimate_items
(cod WBS, material_id, supplier_id, qty, unit, unit_cost, waste_factor,
origem_preco, flag_duvida, is_allowance)
invoices (projeto_id OPCIONAL, fornecedor, número, data, total, arquivo)
invoice_items (invoice, cod WBS sugerido/confirmado, descrição,
qty, unit, unit_cost, total, material_id vinculado)
county_parameters · actual_costs · spec_documents · change_orders
draw_schedules · bt_costcode_map (WBS PKB → cost code Buildertrend) · rfq_requests (Fase 3)
```

---

# PARTE 6 — Roadmap

| Sprint | Entrega |
|---|---|
| 1 | Setup + cadastros (fornecedores, materiais com níveis, county_parameters) + import do modelo XLSX |
| 2 | Upload de projeto + Agente de Takeoff + tela de revisão editável |
| 3 | Motor de níveis: 3 cenários automáticos + mix & match + delta pricing |
| 4 | Agente de Preços (cotações + histórico + busca web com fotos) |
| 5 | Saídas: XLSX padrão + export Buildertrend-ready + Memorial Descritivo + Proposta Comparativa + Draw schedule |
| 6 | Fase 2: Agente de Invoices + custos reais + conciliação tripla + motor de calibração + dashboard |
| 7 | Fase 3: RFQ automático por e-mail + parsing de respostas |

**Critério de sucesso:** qualquer pessoa do comercial sobe um projeto e, em minutos, responde ao cliente: "esse projeto custa $X, $Y ou $Z — e aqui está exatamente o que cada valor entrega, com foto e especificação".
