# PKB Ops — Segurança e plano de resposta a incidentes

Criado em 17/11/2026 (Victor). Responsável: Victor Kubrusly (victor@pkbhomes.com).

## Vigilância (o robô de segurança)

`ops/rules/security_watch.mjs` roda de hora em hora (workflow `ops-mail`). Ele só lê e grava os próprios
achados em `ops.security_findings`.

| O que vigia | Como |
|---|---|
| Configuração de login | Cadastro público tem que estar desligado, senha mínima 12, chaves antigas (JWT) desligadas |
| Brechas conhecidas | Security advisor do Supabase: avisa só o que for novo |
| Exposição | Tabela da API sem RLS, bucket de arquivos público |
| Contas | Login novo criado; alguém novo virando membro de uma empresa real |
| Ataques | Senhas erradas em rajada (por IP e no total), tentativas de cadastro |
| Abuso | Chamadas de IA por hora (uso indevido da chave da Anthropic), e-mails enviados por hora |

- **Crítico / alto** → e-mail na hora para o Victor (mesmo com os envios desligados).
- **Médio / baixo** → relatório semanal, às segundas.
- Cada achado avisa uma vez; quando a condição some, ele é marcado como resolvido.

## Níveis

| Nível | Exemplos | Prazo |
|---|---|---|
| Crítico | Dados expostos, conta invadida, chave vazada em uso, apagamento | Agir agora (passo 1) |
| Alto | Rajada de senhas erradas, login desconhecido criado, membro novo inesperado, pico de IA ou e-mails | Hoje |
| Médio | Brecha nova no advisor, tentativa de cadastro | Na semana |

## Plano de resposta (crítico)

### 1. Conter — minutos
1. `cd ops && SUPABASE_ACCESS_TOKEN=… node scripts/panic.mjs on`
   pausa todos os robôs (pg_cron) e desconecta todo mundo. Os tokens já emitidos valem até 1 hora.
2. GitHub → Actions: desative os workflows `ops-*` (eles têm cron próprio de reserva).
3. Se a origem for uma conta: Supabase → Authentication → Users → banir o usuário.
4. Se for um IP: Supabase → Settings → Network restrictions.

### 2. Trocar credenciais — mesmo dia
Troque primeiro o que pode ter vazado; na dúvida, todas.

| Credencial | Onde vive | Como trocar |
|---|---|---|
| Token de gestão do Supabase (`SUPABASE_ACCESS_TOKEN`) | Segredo do GitHub | supabase.com → Account → Access Tokens: revogar e criar outro; atualizar o segredo |
| Chave secreta do projeto (`sb_secret_…`) | Supabase (as funções a recebem automaticamente) | Supabase → Settings → API Keys: criar uma nova e apagar a antiga |
| Chave de assinatura JWT antiga (HS256) e chaves `anon`/`service_role` | Supabase | Settings → JWT Keys: revogar a HS256; API Keys: desligar as chaves legadas |
| `ANTHROPIC_API_KEY` | Segredo das Edge Functions do Supabase | console.anthropic.com: revogar e criar outra; atualizar o segredo |
| Senha do e-mail do robô (`BOT_EMAIL_PASSWORD`) | Segredo do GitHub | Conta Google do bot: trocar a senha e a senha de app; conferir regras de encaminhamento e logins recentes |
| Sessão do Buildertrend (`BT_COOKIES_JSON`) | Segredo do GitHub | Buildertrend: sair de todas as sessões, trocar a senha do usuário do robô e exportar novos cookies |
| Token do GitHub para os disparos (`github_actions_token`) | Vault do Supabase | GitHub → Settings → Developer settings: revogar e criar outro; atualizar o Vault |
| Senhas dos usuários | Supabase Auth | Aba Users do PKB Ops: enviar link de troca de senha |

### 3. Investigar — antes que os logs expirem
- Os logs do Supabase guardam pouco tempo. Exporte logo os de auth, API, storage e funções
  (Supabase → Logs, ou a API de gestão `analytics/endpoints/logs`).
- `ops.security_findings`: o que o robô viu e quando.
- `ops.outbound_messages`: o que saiu (e-mails, Daily Logs).
- GitHub → Settings → Audit log: segredos acessados e workflows alterados.
- Responda: o que foi acessado, de quais pessoas (clientes, investidores, equipe), desde quando.

### 4. Recuperar
- **Hoje não há backup do banco** (o plano gratuito do Supabase não faz). Pendência: plano Pro, com
  backup diário de 7 dias e checagem de senhas vazadas, ou um backup próprio todas as noites.
- Depois de limpo: `node scripts/panic.mjs off` e reative os workflows no GitHub.

### 5. Comunicar
- A lei da Flórida (Fla. Stat. 501.171) exige avisar as pessoas afetadas em até 30 dias quando
  vazam certos dados pessoais, e o Procurador-Geral quando são 500 ou mais pessoas. **Confirmar
  com o advogado** o que se aplica ao caso.
- Avisar os sócios no mesmo dia. Avisar clientes e investidores com texto revisado pelo advogado.

### 6. Revisar
Em até uma semana: o que aconteceu, por que a vigilância pegou (ou não), o que muda. Registrar aqui.

## Histórico
- **17/11/2026** — Revisão de segurança:
  - cadastro público desligado; senha mínima 12;
  - `join_org` travado na empresa demo (antes, quem soubesse o código da PKB entrava como membro);
  - funções `create_org` e `is_org_member` fechadas para anônimos;
  - robô de segurança e este plano criados;
  - a chave JWT antiga (HS256) apareceu no histórico de uma sessão de trabalho: as funções e o
    robô passaram para as chaves novas; em seguida as chaves antigas são desligadas e a HS256 revogada.
