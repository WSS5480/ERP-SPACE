-- 0006_connections.sql
-- One connection of every channel, so each path is exercised rather than
-- described. Three banks, three different ways of handing over a statement,
-- because that is what actually happens when stores bank locally.
--
--   Enola      First Valley      SFTP, BAI2, 06:00 every weekday
--   Palestine  Pineywoods State  API, polled hourly
--   Socorro    Rio Commerce      email; the bank offers nothing else
--   Operating  First Valley      manual upload, for the days a feed is down
--
-- Plus the A/P inbox, the POS drop, and the outbound payment file.
--
-- Credential references point at a secrets store that does not exist yet.
-- That is deliberate: the schema refuses to hold the secret itself.

begin;

-- ------------------------------------------------------- bank statements --

insert into connection
  (tenant_id, entity_id, source_code, channel, name, bank_account_id,
   config, credential_ref, schedule_cron, status, created_by)
select '11111111-1111-1111-1111-111111111111',
       '22222222-2222-2222-2222-222222222222',
       'bank_statement', 'sftp', 'First Valley BAI2 drop',
       (select id from bank_account where account_last4 = '2210'),
       jsonb_build_object(
         'host', 'sftp.firstvalley.example',
         'port', '22',
         'path', '/outbound/pentex',
         'glob', 'PENTEX_*.BAI',
         'format', 'bai2',
         'archiveTo', '/outbound/pentex/processed'),
       'secret://sftp/first-valley/pentex',
       '0 6 * * 1-5',
       'active',
       '55555555-0000-0000-0000-000000000002';

insert into connection
  (tenant_id, entity_id, source_code, channel, name, bank_account_id,
   config, credential_ref, schedule_cron, status, created_by)
select '11111111-1111-1111-1111-111111111111',
       '22222222-2222-2222-2222-222222222222',
       'bank_statement', 'api', 'Pineywoods transactions API',
       (select id from bank_account where account_last4 = '8043'),
       jsonb_build_object(
         'endpoint', 'https://api.pineywoods.example/v1/accounts/8043/transactions',
         'format', 'ofx',
         'window', '3'),
       'secret://api/pineywoods/pentex',
       '0 * * * *',
       'active',
       '55555555-0000-0000-0000-000000000002';

insert into connection
  (tenant_id, entity_id, source_code, channel, name, bank_account_id,
   config, allowed_senders, status, created_by)
select '11111111-1111-1111-1111-111111111111',
       '22222222-2222-2222-2222-222222222222',
       'bank_statement', 'email', 'Rio Commerce emailed statement',
       (select id from bank_account where account_last4 = '5512'),
       jsonb_build_object('mailbox', 'statements@pentex.example', 'format', 'csv',
         'mapping', jsonb_build_object(
           'date', 'Posted Date', 'description', 'Description',
           'amount', 'Amount', 'ref', 'Reference', 'dateFormat', 'MM/DD/YYYY')),
       array['statements@riocommerce.example', '@riocommerce.example'],
       'active',
       '55555555-0000-0000-0000-000000000002';

insert into connection
  (tenant_id, entity_id, source_code, channel, name, bank_account_id,
   config, status, created_by)
select '11111111-1111-1111-1111-111111111111',
       '22222222-2222-2222-2222-222222222222',
       'bank_statement', 'manual_upload', 'Operating account, exported by hand',
       (select id from bank_account where account_last4 = '7788'),
       jsonb_build_object('format', 'bai2'),
       'active',
       '55555555-0000-0000-0000-000000000001';

-- --------------------------------------------------------------- payables --

insert into connection
  (tenant_id, entity_id, source_code, channel, name, config, allowed_senders, status, created_by)
values ('11111111-1111-1111-1111-111111111111',
        '22222222-2222-2222-2222-222222222222',
        'invoice', 'email', 'A/P inbox',
        jsonb_build_object('mailbox', 'ap@pentex.example'),
        array['@valleypower.example', '@lonestarfuel.example', '@meridianfreight.example'],
        'active',
        '55555555-0000-0000-0000-000000000003');

-- -------------------------------------------------------------- POS feed --

insert into connection
  (tenant_id, entity_id, source_code, channel, name, location_id,
   config, credential_ref, schedule_cron, status, created_by)
select '11111111-1111-1111-1111-111111111111',
       '22222222-2222-2222-2222-222222222222',
       'pos_deposit', 'sftp', 'POS nightly takings',
       '33333333-0000-0000-0000-000000000002',
       jsonb_build_object('host', 'pos-export.example', 'path', '/nightly',
                          'glob', 'takings_*.csv', 'format', 'csv'),
       'secret://sftp/pos/pentex',
       '30 2 * * *',
       'active',
       '55555555-0000-0000-0000-000000000002';

-- --------------------------------------------------------- money going out --

insert into connection
  (tenant_id, entity_id, source_code, channel, name, bank_account_id,
   config, credential_ref, status, created_by)
select '11111111-1111-1111-1111-111111111111',
       '22222222-2222-2222-2222-222222222222',
       'payment_file', 'sftp', 'First Valley ACH origination',
       (select id from bank_account where account_last4 = '7788'),
       jsonb_build_object('host', 'sftp.firstvalley.example', 'path', '/inbound/ach',
                          'format', 'nacha'),
       'secret://sftp/first-valley/ach',
       'active',
       '55555555-0000-0000-0000-000000000001';

commit;
