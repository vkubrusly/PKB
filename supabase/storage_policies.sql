-- =============================================================================
-- storage_policies.sql — políticas do bucket "plantas" (upload de plantas p/ IA).
--
-- Rode UMA VEZ no Supabase → SQL Editor (depois de criar o bucket "plantas").
-- Sem isto, o upload de plantas no "Take-off por IA" retorna 403.
--
-- Regra: um membro da org pode subir/ler arquivos dentro da pasta da PRÓPRIA org
-- (o app grava em  <org_id>/<arquivo>).  Faz JOIN direto em public.org_members —
-- não depende de nenhuma função auxiliar.  Idempotente.
--
-- PRÉ-REQUISITO: a tabela public.org_members precisa existir (vem do deploy_all.sql
-- / migration 0002). Se este SQL falhar com "relation org_members does not exist",
-- rode antes o supabase/deploy_all.sql — o schema ainda não foi aplicado.
-- =============================================================================

-- 0) Cria o bucket "plantas" (privado) se ainda não existir.
--    Sem isto o upload retorna 400 "Bucket not found".
insert into storage.buckets (id, name, public)
values ('plantas', 'plantas', false)
on conflict (id) do nothing;

drop policy if exists "plantas_org_upload" on storage.objects;
create policy "plantas_org_upload"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'plantas'
    and exists (
      select 1 from public.org_members m
      where m.user_id = auth.uid()
        and m.org_id = ((storage.foldername(name))[1])::uuid
    )
  );

drop policy if exists "plantas_org_read" on storage.objects;
create policy "plantas_org_read"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'plantas'
    and exists (
      select 1 from public.org_members m
      where m.user_id = auth.uid()
        and m.org_id = ((storage.foldername(name))[1])::uuid
    )
  );
