-- The product has used the neutral interface-intensity name since state v3.
-- Keep the retained normalized settings table aligned with that terminology.

alter table public.user_settings
  rename column game_intensity to interface_intensity;
