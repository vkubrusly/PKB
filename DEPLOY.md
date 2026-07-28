# Colocar no ar (Supabase + IA + domínio)

Guia de go-live. Divide o que **só você pode fazer** (contas, chaves, domínio) do
que **já está pronto no repo** (schema, funções, build, config de host).

---

## 0. O que você precisa ter (uma vez)

| Item | Onde | Custo |
|---|---|---|
| Conta **Supabase** + 1 projeto | supabase.com | Free para começar · Pro ~US$25/mês |
| **ANTHROPIC_API_KEY** (Claude) | console.anthropic.com | Pré-pago por uso |
| Conta de host do site (**Vercel** ou Netlify) | vercel.com | Free para começar |
| **Domínio** | você já tem `victorkubrusly.com` | ~US$12/ano |
| CLI: `npm i -g supabase` e `vercel` | — | grátis |

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

## 2. Frontend — build + host

```bash
cd frontend
# .env de produção
echo "VITE_SUPABASE_URL=https://<ref>.supabase.co"   > .env.production
echo "VITE_SUPABASE_ANON_KEY=<anon-key>"            >> .env.production

# Deploy na Vercel (usa frontend/vercel.json — SPA, output dist)
vercel --prod
```

Na Vercel: **Root Directory = `frontend`**, Build = `npm run build`, Output = `dist`.
Defina as duas variáveis `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` no painel
do projeto (Settings → Environment Variables) além do `.env.production`.

---

## 3. Domínio

1. Na Vercel: Project → **Settings → Domains** → adicionar
   `orcamentos.victorkubrusly.com` (ou o subdomínio que preferir).
2. No seu DNS (onde o domínio está registrado): criar o registro **CNAME** que a
   Vercel indicar (aponta o subdomínio para a Vercel). Propaga em minutos.
3. Volte ao Supabase → Auth → **Site URL** = `https://orcamentos.victorkubrusly.com`
   e adicione-o em **Redirect URLs**. (Senão o login redireciona errado.)

Pronto: `https://orcamentos.victorkubrusly.com` no ar, com HTTPS automático.

---

## Resumo: quem faz o quê

| Etapa | Você | Já pronto no repo |
|---|---|---|
| Criar projeto Supabase + chave Claude + domínio | ✅ | — |
| Schema do banco (migrations + WBS) | roda `db push` | ✅ |
| Funções de IA (takeoff / preço / detalhamento) | roda `deploy` + `secrets set` | ✅ código |
| Build do site + config de SPA | roda `vercel --prod` | ✅ `vercel.json` |
| Apontar o domínio (CNAME + Site URL) | ✅ | — |

Detalhe das funções de IA: [`docs/AI_SETUP.md`](docs/AI_SETUP.md).

---

## Custo mensal aproximado (início)

- Supabase Free (ou Pro US$25 quando crescer) · Vercel Free · domínio ~US$1/mês.
- Claude API: só o que usar (um take-off de plantas custa centavos; buscas de
  preço, frações de centavo). Comece sem compromisso e acompanhe pelo console.
