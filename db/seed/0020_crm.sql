-- 0020_crm.sql
-- PLACEHOLDER customers-and-marketing data for the demo company: a marketing
-- person, a round-robin rule for the Enola showroom, profiles with tags and
-- preferences, consent on file, leads at every stage with their follow-ups,
-- two saved segments, a draft campaign with its coupon. Nothing here is real.

begin;

insert into app_user (id, tenant_id, email, name) values
  ('55555555-0000-0000-0000-000000000020','11111111-1111-1111-1111-111111111111','marketing@example.com','Sam (marketing)');
insert into role_grant (app_user_id, entity_id, role) values
  ('55555555-0000-0000-0000-000000000020','22222222-2222-2222-2222-222222222222','marketing');

-- Walk-ins and web leads at Enola go to Maria and the Enola manager in turn.
insert into crm_assignment_rule (entity_id, name, location_id, members) values
  ('22222222-2222-2222-2222-222222222222','Enola showroom rotation','33333333-0000-0000-0000-000000000001',
   array['55555555-0000-0000-0000-000000000011','55555555-0000-0000-0000-000000000018']::uuid[]),
  ('22222222-2222-2222-2222-222222222222','Everything else','33333333-0000-0000-0000-000000000002',
   array['55555555-0000-0000-0000-000000000018']::uuid[]);

insert into crm_household (id, entity_id, name) values
  ('9c9c0000-0000-0000-0000-000000000001','22222222-2222-2222-2222-222222222222','Gomez–Kelly household');

insert into crm_profile (customer_id, entity_id, household_id, tags, styles, rooms, budget_minor, birthday, preferred_channel) values
  ('88888888-0000-0000-0000-000000000001','22222222-2222-2222-2222-222222222222','9c9c0000-0000-0000-0000-000000000001',
   '{vip,designer-referral}','{modern,coastal}','{living room,bedroom}',400000,('1984-' || to_char(now(),'MM') || '-14')::date,'sms'),
  ('88888888-0000-0000-0000-000000000002','22222222-2222-2222-2222-222222222222','9c9c0000-0000-0000-0000-000000000001',
   '{}','{farmhouse}','{dining}',150000,'1979-03-02'::date,'email'),
  ('88888888-0000-0000-0000-000000000004','22222222-2222-2222-2222-222222222222',null,'{repeat}','{traditional}','{bedroom}',null,null,'call');

insert into crm_relation (entity_id, customer_id, related_id, relation) values
  ('22222222-2222-2222-2222-222222222222','88888888-0000-0000-0000-000000000001','88888888-0000-0000-0000-000000000002','spouse');

insert into crm_consent (entity_id, customer_id, channel, status, source, captured_at, evidence) values
  ('22222222-2222-2222-2222-222222222222','88888888-0000-0000-0000-000000000001','email','opt_in','pos', now() - interval '200 days','signed at the register'),
  ('22222222-2222-2222-2222-222222222222','88888888-0000-0000-0000-000000000001','sms','opt_in','pos', now() - interval '200 days','signed at the register'),
  ('22222222-2222-2222-2222-222222222222','88888888-0000-0000-0000-000000000003','email','opt_in','web_form', now() - interval '90 days',null),
  ('22222222-2222-2222-2222-222222222222','88888888-0000-0000-0000-000000000004','email','opt_out','unsubscribe link', now() - interval '30 days',null);

insert into crm_note (entity_id, customer_id, body, created_by, created_at) values
  ('22222222-2222-2222-2222-222222222222','88888888-0000-0000-0000-000000000001','Measuring the den for a sectional; wants performance fabric because of the dog.',
   '55555555-0000-0000-0000-000000000011', now() - interval '10 days');

-- Leads across the pipeline.
insert into crm_lead (id, entity_id, number, source, utm_source, utm_medium, name, email, phone, interest, estimate_minor, customer_id,
                      location_id, assigned_to, stage, lost_reason, next_follow_up_at, first_response_at, lost_at, created_at) values
  ('9d9d0000-0000-0000-0000-000000000001','22222222-2222-2222-2222-222222222222','L-000001','walk_in',null,null,'Priya Shah','priya@example.com','7175550111',
   'Sectional in performance fabric, 110" max',249900,null,'33333333-0000-0000-0000-000000000001','55555555-0000-0000-0000-000000000011',
   'new',null, now() - interval '2 hours', null, null, now() - interval '3 hours'),
  ('9d9d0000-0000-0000-0000-000000000002','22222222-2222-2222-2222-222222222222','L-000002','web_form','web store','contact form','Tom Rivera','tom@example.com',null,
   'Dining set for eight',180000,null,'33333333-0000-0000-0000-000000000001','55555555-0000-0000-0000-000000000018',
   'contacted',null, now() + interval '1 day', now() - interval '20 hours', null, now() - interval '1 day'),
  ('9d9d0000-0000-0000-0000-000000000003','22222222-2222-2222-2222-222222222222','L-000003','referral',null,null,'Grace Lee',null,'7175550133',
   'Bedroom refresh, referred by Alicia',320000,null,'33333333-0000-0000-0000-000000000001','55555555-0000-0000-0000-000000000011',
   'appointment',null, now() + interval '2 days', now() - interval '3 days', null, now() - interval '4 days'),
  ('9d9d0000-0000-0000-0000-000000000004','22222222-2222-2222-2222-222222222222','L-000004','phone',null,null,'Brian Kelly','brian@example.com','7175550102',
   'Recliner for the den',64999,'88888888-0000-0000-0000-000000000002','33333333-0000-0000-0000-000000000001','55555555-0000-0000-0000-000000000018',
   'lost','bought elsewhere', null, now() - interval '9 days', now() - interval '5 days', now() - interval '10 days');
update crm_lead set referred_by = '88888888-0000-0000-0000-000000000001' where id = '9d9d0000-0000-0000-0000-000000000003';
insert into doc_sequence (entity_id, kind, prefix, next_no) values ('22222222-2222-2222-2222-222222222222','lead','L-',5)
  on conflict (entity_id, kind) do update set next_no = greatest(doc_sequence.next_no, 5);

insert into crm_lead_event (entity_id, lead_id, kind, detail, at) values
  ('22222222-2222-2222-2222-222222222222','9d9d0000-0000-0000-0000-000000000001','created','walk in', now() - interval '3 hours'),
  ('22222222-2222-2222-2222-222222222222','9d9d0000-0000-0000-0000-000000000002','created','web form', now() - interval '1 day'),
  ('22222222-2222-2222-2222-222222222222','9d9d0000-0000-0000-0000-000000000003','created','referral', now() - interval '4 days'),
  ('22222222-2222-2222-2222-222222222222','9d9d0000-0000-0000-0000-000000000004','stage','lost (bought elsewhere)', now() - interval '5 days');

insert into crm_task (entity_id, assigned_to, kind, title, due_at, ends_at, location_id, customer_id, lead_id, auto) values
  ('22222222-2222-2222-2222-222222222222','55555555-0000-0000-0000-000000000011','call','First contact: Priya Shah', now() - interval '2 hours', null, null, null,
   '9d9d0000-0000-0000-0000-000000000001', true),
  ('22222222-2222-2222-2222-222222222222','55555555-0000-0000-0000-000000000018','email','Send dining set options to Tom Rivera', now() + interval '1 day', null, null, null,
   '9d9d0000-0000-0000-0000-000000000002', true),
  ('22222222-2222-2222-2222-222222222222','55555555-0000-0000-0000-000000000011','appointment','Design consultation: Grace Lee',
   date_trunc('day', now()) + interval '2 days 15 hours', date_trunc('day', now()) + interval '2 days 16 hours',
   '33333333-0000-0000-0000-000000000001', null, '9d9d0000-0000-0000-0000-000000000003', false),
  ('22222222-2222-2222-2222-222222222222','55555555-0000-0000-0000-000000000011','text','Delivery-day check-in with Alicia', now() + interval '3 hours', null, null,
   '88888888-0000-0000-0000-000000000001', null, false);

insert into crm_segment (id, entity_id, name, filter) values
  ('9e9e0000-0000-0000-0000-000000000001','22222222-2222-2222-2222-222222222222','Everyone (consent is checked at send)','{}'),
  ('9e9e0000-0000-0000-0000-000000000002','22222222-2222-2222-2222-222222222222','Birthdays this month','{"birthdayMonth": 0}'),
  ('9e9e0000-0000-0000-0000-000000000003','22222222-2222-2222-2222-222222222222','Bought a sofa 6–18 months ago','{"boughtSubcategory": "Sofas", "monthsAgoMin": 6, "monthsAgoMax": 18}');

insert into crm_campaign (id, entity_id, name, channel, segment_id, subject, body, cost_minor, utm_campaign) values
  ('9f9f0000-0000-0000-0000-000000000001','22222222-2222-2222-2222-222222222222','Fall living room event','email','9e9e0000-0000-0000-0000-000000000001',
   'Fall living room event, {{first_name}}',
   E'Hi {{first_name}},\n\nOur fall living room event is on at {{store}}. Use code {{coupon}} for 10% off sofas and sectionals, in store or online.\n\nSee you soon.',
   25000, 'fall-living-room-event');

insert into crm_coupon (entity_id, code, campaign_id, kind, pct_bps, amount_minor, min_spend_minor, starts_on, ends_on, max_uses) values
  ('22222222-2222-2222-2222-222222222222','FALL10','9f9f0000-0000-0000-0000-000000000001','percent',1000,null,50000, current_date - 1, current_date + 60, 500),
  ('22222222-2222-2222-2222-222222222222','WELCOME25',null,'amount',null,2500,0, current_date - 1, current_date + 365, null);

commit;
