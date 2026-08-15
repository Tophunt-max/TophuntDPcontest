-- Contest banner/photo image. Shown on the contest card in the user app
-- (apps/expo/app/contest/photo/index.tsx reads `bannerUrl`). Admins set it from
-- the New/Edit Contest form in the admin panel.
ALTER TABLE contests ADD COLUMN banner_url TEXT;
