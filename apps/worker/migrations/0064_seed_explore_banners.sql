-- Seed the first production Explore carousel.
--
-- Images are version-controlled static assets at
-- apps/expo/public/explore-banners/*.svg, so they deploy atomically with the app,
-- are served from tophunt.in (no third-party tracking / expiry), and stay editable
-- from Admin -> Explore Page like any uploaded banner.
--
-- Preserve an admin's work: only an absent or EMPTY banners array receives the
-- set. Existing non-empty banners and existing section order/visibility win.
UPDATE settings
SET data = json_set(
      data,
      '$.explore.banners',
      CASE
        WHEN json_type(data, '$.explore.banners') IS NULL
          OR (json_type(data, '$.explore.banners') = 'array' AND json_array_length(data, '$.explore.banners') = 0)
        THEN json('[
          {"id":"refer-and-earn","imageUrl":"https://tophunt.in/explore-banners/referral.svg","title":"Dost ko invite karo, dono ko coins!","subtitle":"Pehla contest join hote hi reward unlock hoga","link":"/referral","enabled":true,"startsAt":null,"endsAt":null},
          {"id":"photo-battle","imageUrl":"https://tophunt.in/explore-banners/photo-battle.svg","title":"Apni photo ko battle mein lao","subtitle":"Photo upload karo, rival ko challenge karo, votes jeeto","link":"/contest/photo","enabled":true,"startsAt":null,"endsAt":null},
          {"id":"video-battle","imageUrl":"https://tophunt.in/explore-banners/video-battle.svg","title":"Video battle shuru karo","subtitle":"Apna best clip dikhao aur community ka vote jeeto","link":"/contest/video","enabled":true,"startsAt":null,"endsAt":null},
          {"id":"trending-battles","imageUrl":"https://tophunt.in/explore-banners/trending.svg","title":"Aaj kaun jeetega? Vote karo","subtitle":"Abhi trending live battles dekho","link":"/explore/battles?kind=trending","enabled":true,"startsAt":null,"endsAt":null},
          {"id":"leaderboard","imageUrl":"https://tophunt.in/explore-banners/leaderboard.svg","title":"Leaderboard par chha jao","subtitle":"Battle jeeto, XP kamao aur TopHunt rank badhao","link":"/explore/leaderboard","enabled":true,"startsAt":null,"endsAt":null},
          {"id":"dpcoin-store","imageUrl":"https://tophunt.in/explore-banners/coin-store.svg","title":"Dpcoins ready rakho","subtitle":"Battle entry ke liye secure store se coins lo","link":"/wallet/store","enabled":true,"startsAt":null,"endsAt":null}
        ]')
        ELSE json_extract(data, '$.explore.banners')
      END,
      '$.explore.sections',
      CASE
        WHEN json_type(data, '$.explore.sections') IS NULL
          OR (json_type(data, '$.explore.sections') = 'array' AND json_array_length(data, '$.explore.sections') = 0)
        THEN json('[
          {"key":"banners","enabled":true},
          {"key":"quickActions","enabled":true},
          {"key":"trending","enabled":true},
          {"key":"endingSoon","enabled":true},
          {"key":"contests","enabled":true},
          {"key":"openBattles","enabled":true},
          {"key":"topCreators","enabled":true},
          {"key":"people","enabled":true},
          {"key":"grid","enabled":true}
        ]')
        ELSE json_extract(data, '$.explore.sections')
      END
    ),
    updated_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE id = 'appConfig' AND json_valid(data);