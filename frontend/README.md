# Frontend — PKB Orçamentos

App React + Vite + TypeScript. Fala com o Supabase via `supabase-js` (Auth + RLS).
UI em português.

## Rodar localmente

```bash
# 1. Suba o Supabase local (na raiz do repo)
supabase start
supabase db reset            # aplica migrations + seed (WBS)

# 2. Carregue o projeto-demo Sunny (dado real, validado)
psql "$(supabase status -o env | grep DB_URL | cut -d= -f2)" \
  -f ../data/sunny_affordable/seed_sunny_affordable.sql

# 3. Configure o frontend
cd frontend
cp .env.example .env.local   # preencha URL + anon key (supabase status mostra)
npm install
npm run dev                  # http://localhost:3000
```

## Primeiro acesso

1. **Criar conta** na tela de login (e-mail + senha).
2. Como você ainda não tem organização, aparece o onboarding:
   - **Entrar na organização demo (Sunny)** → vê o projeto real com as 22
     categorias e 77 linhas fechando em **$204.641,90**, ou
   - **Criar organização** → começa uma org vazia sua.

> A org-demo usa o botão "Entrar na organização demo", que chama o RPC
> `join_org` com o `VITE_DEMO_ORG_ID`. Em produção, isso vira convite real.

## Telas (Sprint 2)

| Rota | O quê |
|---|---|
| `/projetos` | Lista de projetos + criar projeto |
| `/projetos/:id` | Ficha do projeto + orçamento por WBS (subtotais, total, $/sf) |
| `/materiais` | Cadastro de materiais (nível, categoria WBS, FL#, fornecedor) |
| `/fornecedores` | Cadastro de fornecedores |
| `/niveis` | Faixas de $/sf alvo por nível (Essential/Signature/Luxury) |

## Scripts

- `npm run dev` — servidor de desenvolvimento
- `npm run build` — typecheck (`tsc --noEmit`) + build de produção
- `npm run typecheck` — só o typecheck

## Notas técnicas

- **Multi-tenant + RLS:** toda query é filtrada por org via RLS no banco; o app
  também filtra por `activeOrg` explicitamente. Criar org passa pelo RPC
  `create_org` (`security definer`), porque `orgs` não tem policy de INSERT.
- **Tipos:** `src/lib/database.types.ts` espelha o schema à mão. Quando quiser,
  troque por `supabase gen types typescript` para gerar automaticamente.
