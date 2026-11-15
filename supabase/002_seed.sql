-- =====================================================================
-- Rumo — dados iniciais (OPCIONAL)
-- O próprio app cria estes registros no primeiro acesso, quando vê que o
-- servidor está vazio. Use este arquivo só se preferir criar pelo SQL
-- (por exemplo, para recomeçar do zero depois de apagar tudo).
--
-- 1. Entre no app uma vez (para o seu usuário existir em auth.users).
-- 2. Troque o e-mail abaixo e rode no SQL Editor. Pode rodar de novo:
--    nada é duplicado.
-- =====================================================================

do $$
declare
  v_email text := 'seu-email@exemplo.com';   -- ← troque
  uid uuid;
begin
  select id into uid from auth.users where email = v_email;
  if uid is null then
    raise exception 'Usuário % não encontrado. Entre no app uma vez antes.', v_email;
  end if;

  insert into public.settings (user_id, display_name, start_date, start_weight_kg, target_weight_kg)
  values (uid, 'Rafael', '2026-10-28', 74.0, 80.0)
  on conflict (user_id) do nothing;

  insert into public.kcal_targets (user_id, effective_from, kcal, reason)
  values (uid, '2026-10-28', 2900, 'Plano inicial')
  on conflict (user_id, effective_from) do nothing;

  insert into public.macro_goals (user_id, macro, target_g, rule, low_g, high_g) values
    (uid, 'protein', 166, 'min',   null, null),
    (uid, 'carb',    400, 'range', 360,  440),
    (uid, 'fat',      90, 'max',   null, 100)
  on conflict (user_id, macro) do nothing;

  if not exists (select 1 from public.meal_types where user_id = uid) then
    insert into public.meal_types (user_id, name, default_time, active, sort) values
      (uid, 'Café da manhã',     '07:00', true,  1),
      (uid, 'Lanche da manhã',   '10:00', false, 2),
      (uid, 'Almoço',            '12:30', true,  3),
      (uid, 'Lanche pré-treino', '16:30', true,  4),
      (uid, 'Pós-treino',        '18:30', false, 5),
      (uid, 'Jantar',            '19:00', true,  6),
      (uid, 'Ceia',              '22:00', true,  7);
  end if;

  -- Os 16 alimentos de design/Alimentos.dc.html (valores aproximados da TACO).
  if not exists (select 1 from public.foods where user_id = uid) then
    insert into public.foods (user_id, name, kcal_100g, protein_100g, carb_100g, fat_100g,
                              label_basis, unit_g, unit_label, last_grams, use_count) values
      (uid, 'Arroz branco cozido',      128,  2.5, 28.1,   0.2, '100g', null, null,    220, 41),
      (uid, 'Aveia em flocos',          394, 13.9, 66.6,   8.5, '100g', null, null,     50, 35),
      (uid, 'Azeite de oliva',          884,  0,    0,   100,   '100g',    8, 'colher', 10, 44),
      (uid, 'Banana prata',              98,  1.3, 26.0,   0.1, '100g', null, null,    120, 52),
      (uid, 'Batata-doce cozida',        77,  0.6, 18.4,   0.1, '100g', null, null,    250, 22),
      (uid, 'Brócolis cozido',           25,  2.1,  4.4,   0.5, '100g', null, null,     80, 21),
      (uid, 'Feijão carioca cozido',     76,  4.8, 13.6,   0.5, '100g', null, null,    160, 30),
      (uid, 'Iogurte natural',           51,  4.1,  1.9,   3.0, '100g',  170, 'pote',  170, 15),
      (uid, 'Mel',                      309,  0,   84.0,   0,   '100g', null, null,     15, 24),
      (uid, 'Ovo inteiro cozido',       146, 13.3,  0.6,   9.5, '100g',   50, 'un',    150, 40),
      (uid, 'Pão de forma integral',    253,  9.4, 49.9,   3.7, '100g',   25, 'fatia',  75, 31),
      (uid, 'Pasta de amendoim',        588, 25.1, 20.0,  50.4, '100g', null, null,     20, 20),
      (uid, 'Patinho grelhado',         219, 35.9,  0,     7.3, '100g', null, null,    150, 18),
      (uid, 'Peito de frango grelhado', 159, 32.0,  0,     2.5, '100g', null, null,    150, 38),
      (uid, 'Queijo minas frescal',     264, 17.4,  3.2,  20.2, '100g', null, null,     30, 19),
      (uid, 'Whey protein',             400, 80,    8,     6,   '100g',   30, 'scoop',  30, 39);
  end if;
end $$;
