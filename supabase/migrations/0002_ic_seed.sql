-- inventario-conf: initial config (phase 0 setup 0.2 step 4). Everything here is editable later in the app.

insert into public.ic_cycle (anchor_monday) values ('2026-11-09');   -- global week 1

-- hubs: Tue–Fri for the 3-aux hubs, Mon–Fri for the rest
insert into public.ic_hub_config (hub_slug, login_id, display_name, workdays) values
  ('mh-contry',      'con', 'Contry',      '{2,3,4,5}'),
  ('mh-condesa',     'csa', 'Condesa',     '{2,3,4,5}'),
  ('mh-zapopan',     'zap', 'Zapopan',     '{2,3,4,5}'),
  ('mh-cumbres',     'cu',  'Cumbres',     '{1,2,3,4,5}'),
  ('mh-san-nicolas', 'sn',  'San Nicolás', '{1,2,3,4,5}'),
  ('mh-guadalupe',   'gpe', 'Guadalupe',   '{1,2,3,4,5}'),
  ('mh-avicola',     'avi', 'Avícola',     '{1,2,3,4,5}');
-- turno_split 14:00, moved_threshold 20, done_ratio 0.8, late_window_days 2 come from column defaults.

-- roles: every hub has aux_inv / lider_am / lider_pm; Contry, Condesa, Zapopan add aux_rec.
-- aux_cal exists everywhere with capacity 0: it counts toward coverage but gets no plan slots.
insert into public.ic_roles (hub_slug, role_key, label, weekly_capacity, days)
select h.hub_slug, r.role_key, r.label, r.cap, h.workdays
from public.ic_hub_config h
cross join (values
  ('aux_inv',  'Aux. de inventarios', 700),
  ('lider_am', 'Líder turno día',     240),
  ('lider_pm', 'Líder turno tarde',   240),
  ('aux_cal',  'Aux. de calidad',       0)
) as r(role_key, label, cap)
union all
select h.hub_slug, 'aux_rec', 'Aux. de recepción', 300, h.workdays
from public.ic_hub_config h
where h.hub_slug in ('mh-contry', 'mh-condesa', 'mh-zapopan');

-- logins (matched on the part before '@'; anything not listed → extra)
insert into public.ic_logins (hub_slug, login, assign, category_map, note)
select h.hub_slug, 'aux.inventario.' || h.login_id, 'aux_inv', null::jsonb, null::text from public.ic_hub_config h
union all
select h.hub_slug, 'aux.turno.' || h.login_id, 'by_turno', null, 'lider_am / lider_pm by Turno' from public.ic_hub_config h
union all
select h.hub_slug, 'aux.calidad.' || h.login_id, 'aux_cal', null, 'coverage only' from public.ic_hub_config h
where h.hub_slug <> 'mh-contry'
union all
select 'mh-contry', 'aux.calidad.con', 'by_category',
       '{"3. Graneles y abarrotes": "aux_rec", "*": "aux_cal"}'::jsonb,
       'Contry: Abarrotes counts as recepción, the rest as calidad'
union all
select 'mh-condesa', 'aux.recepcion.csa', 'aux_rec', null, null
union all
select 'mh-zapopan', 'aux.recepcion.zap', 'aux_rec', null, null;

-- starter location rules (JS RegExp, first match by priority wins; unmatched codes show in the preview)
insert into public.ic_location_rules (hub_slug, priority, match_regex, normalize_to, kind, group_label, note)
select h.hub_slug, r.priority, r.match_regex, r.normalize_to, r.kind, r.group_label, r.note
from public.ic_hub_config h
cross join (values
  (10,  '^B0*([1-9])$',       'B0$1', 'freezer',     'Congeladores', 'B1 / B01 / B001 → B01'),
  (11,  '^B0*([1-9]\d+)$',    'B$1',  'freezer',     'Congeladores', 'B10 / B010 → B10'),
  (30,  '^(ARMADO|BODEGA|AGUA|FAR)$', null, 'ignore', null,          'to review'),
  (100, '^[A-ZÑ]$',           null,   'shelf_aisle', null,           'single-letter aisle')
) as r(priority, match_regex, normalize_to, kind, group_label, note);

insert into public.ic_location_rules (hub_slug, priority, match_regex, normalize_to, kind, group_label, note) values
  ('mh-san-nicolas', 20, '^(HOLANDA|NESTLÉ)$', null, 'freezer', 'Congeladores', 'brand freezers'),
  ('mh-contry',      40, '^(Q|W)$', 'Cuarto frío $1', 'cold_room', 'Cuarto frío', 'Contry cold room = aisles Q, W');

insert into public.ic_location_rules (hub_slug, priority, match_regex, normalize_to, kind, group_label, note)
select h.hub_slug, 40, '^A$', 'Cuarto frío', 'cold_room', 'Cuarto frío', 'cold room = aisle A'
from public.ic_hub_config h
where h.hub_slug <> 'mh-contry';
