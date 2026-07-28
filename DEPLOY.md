# Colocar no ar (Supabase + IA + domínio)

Guia de go-live. Divide o que **só você pode fazer** (contas, chaves, domínio) do
que **já está pronto no repo** (schema, funções, build, config de host).

---

## 0. O que você precisa ter (uma vez)

| Item | Onde | Custo |
|---|---|---|
| Conta **Supabase** + 1 projeto | supabase.com | Free para começar · Pro ~US$25/mês |
| **ANTHROPIC_API_KEY** (Claude) | console.anthropic.com | Pré-pago por uso |
| Host do site: **GitHub Pages** (você já tem GitHub) | github.com | Free¹ |
| **Domínio** | subdomínio `budget.pkbhomes.com` (registrado na **GoDaddy**) | já é seu |

¹ GitHub Pages publica de graça a partir de repo **público**. Se o repositório for
**privado**, o Pages exige **GitHub Pro** (~US$4/mês) ou Team. Alternativa sem custo e
sem esse limite: **Cloudflare Pages** (grátis, aceita repo privado) — mas exige criar
conta Cloudflare.

---

## 1. Backend — Supabase (banco + auth + storage + IA)

### 1A. Banco SEM instalar nada (recomendado para começar)

1. Supabase → **SQL Editor** → **New query**.
2. Cole todo o conteúdo de **`supabase/deploy_all.sql`** e clique **Run**.
   (Aplica todo o schema + as 22 categorias WBS + o projeto-demo Sunny. Idempotente.)
3. **Storage** → **New bucket** → nome `plantas`, **private**.
4. **Authentication** → habilitar **Email**.

Pronto o banco. As **funções de IA** (passo 1.5) ainda precisam da CLI ou do CI/CD —
não dá para publicá-las pelo painel.

### 1B. Via CLI (alternativa completa)

```bash
# 1.1 Ligar o repo ao seu projeto Supabase
supabase login
supabase link --project-ref <seu-project-ref>

# 1.2 Subir TODO o schema (migrations) — inclui as 22 categorias WBS
supabase db push

# 1.3 (opcional) Carregar o projeto-demo Sunny com dado real
psql "$(supabase db url)" -f data/sunny_affordable/seed_sunny_affordable.sql

# 1.4 Storage: criar o bucket privado "plantas" (para o take-off por IA)
#     Dashboard → Storage → New bucket → nome "plantas", private.

# 1.5 IA: chave + deploy das 3 funções
supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
supabase functions deploy takeoff
supabase functions deploy price-search
supabase functions deploy product-detail
```

Auth: Dashboard → Authentication → habilitar **Email**; em URL Configuration,
apontar o **Site URL** para o seu domínio (passo 3).

Pegue do Dashboard (Settings → API): **Project URL** e **anon key** — vão no passo 2.

---

## 2. Frontend — GitHub Pages (sem conta nova, sem terminal)

O frontend já vem com `frontend/.env.production` (URL + publishable key) e o build
gera `CNAME`, `404.html` e `.nojekyll` automaticamente. O deploy é feito por um
GitHub Action (`.github/workflows/deploy-site.yml`).

1. **Habilitar o Pages:** GitHub → repo → **Settings → Pages** →
   em **Build and deployment → Source**, escolha **GitHub Actions**.
2. **Publicar:** GitHub → aba **Actions** → workflow **Deploy site (GitHub Pages)**
   → **Run workflow**. (Depois roda sozinho a cada push em `frontend/**`.)
   > O workflow só aparece quando estiver na branch **main** — faça o merge da
   > branch de trabalho para `main` antes.
3. Após o DNS (passo 3) propagar, volte em **Settings → Pages** e ligue
   **Enforce HTTPS** (o certificado leva alguns minutos).

## 2C. Funções de IA — GitHub Actions (já rodou ✅)

`.github/workflows/deploy-ai-functions.yml`, com os secrets `SUPABASE_ACCESS_TOKEN`
e `ANTHROPIC_API_KEY`. Aba **Actions** → **Deploy AI functions** → **Run workflow**.

## 3. Domínio — DNS na GoDaddy

Como é um **subdomínio** (`budget`), o registro é um **CNAME** simples:

1. GoDaddy → **My Products** → domínio **pkbhomes.com** → **DNS / Manage DNS**.
2. **Add New Record**:
   | Campo | Valor |
   |---|---|
   | **Type** | `CNAME` |
   | **Name** | `budget` |
   | **Value** | `vkubrusly.github.io` |
   | **TTL** | `1 Hour` (padrão) |
3. **Save**. Propaga em minutos (às vezes até 1h).
4. GitHub → **Settings → Pages → Custom domain**: deve mostrar `budget.pkbhomes.com`
   (vem do arquivo CNAME). Confirme e ligue **Enforce HTTPS**.
5. Supabase → **Authentication → URL Configuration** → **Site URL** =
   `https://budget.pkbhomes.com` (e adicione em **Redirect URLs**).

Pronto: `https://budget.pkbhomes.com` no ar, com HTTPS.

> **Se o repositório for privado e você estiver no plano Free**, o Pages não publica.
> Opções: tornar o repo público, assinar GitHub Pro, ou usar **Cloudflare Pages**
> (grátis, aceita repo privado) — nesse caso o CNAME da GoDaddy aponta para o host
> que a Cloudflare indicar, em vez de `vkubrusly.github.io`.

---

## Resumo: quem faz o quê

| Etapa | Você | Já pronto no repo |
|---|---|---|
| Projeto Supabase + chave Claude + domínio GoDaddy | ✅ | — |
| Schema do banco (SQL no painel, ou `db push`) | cola `deploy_all.sql` | ✅ |
| Funções de IA (takeoff / preço / detalhamento) | "Run workflow" | ✅ Action |
| Build + publicação do site | "Run workflow" | ✅ Action + `.env.production` |
| Apontar o domínio (CNAME na GoDaddy + Site URL) | ✅ | — |

Detalhe das funções de IA: [`docs/AI_SETUP.md`](docs/AI_SETUP.md).

---

## Custo mensal aproximado (início)

- Supabase Free (ou Pro US$25 quando crescer) · **GitHub Pages Free** (repo público;
  ou GitHub Pro ~US$4/mês se privado) · domínio já pago na GoDaddy.
- Claude API: só o que usar (um take-off de plantas custa centavos; buscas de
  preço, frações de centavo). Comece sem compromisso e acompanhe pelo console.
