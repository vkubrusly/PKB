<!--
Rule R0 — "start licensing" e-mail to the designer (Sovereign), sent the day the
1st (licensing) invoice is paid. Source: Guilherme's real template (2026-09-25).
Kept in Portuguese because that is how PKB and Sovereign correspond.
Placeholders are filled from ops.jobs; the draft goes to the Outbox for approval.
To: {{designer.to}}   Cc: {{designer.cc}}, {{internal.permits_owner.email}}
Attachments: owner's Sunbiz; Property Record Card and/or Warranty Deed.
-->
Subject: Requisição Serviços de Building & Septic Permit - {{job.parcel}} & {{job.address}}

Prezados da Sovereign,

Gostaria de solicitar a abertura dos processos de Building Permit & Septic Permit para o terreno conforme dados abaixo:

- Parcel ID: {{job.parcel}}
- Endereço: {{job.address}}
- Modelo da Casa: {{job.model}}
- Utilities: {{job.water_label}} / {{job.sewer_label}}

Em anexo estou enviando os documentos necessários para início dos processos:

- Sunbiz do proprietário ({{job.owner}})
- Property Record Card e/ou Warranty Deed

Já podem por favor solicitar o Survey.

Peço também, por gentileza, que me mantenham atualizado sobre o andamento dos dois processos (Building Permit e Septic Permit), incluindo eventuais exigências, taxas e prazos.

Favor confirmar recebimento.

Atenciosamente,
{{internal.permits_owner.name}}
PKB Homes
