-- Plafond porté de 20 à 50 Mo.
--
-- Les images sont compressées dans le navigateur avant l'envoi (redimensionnées
-- puis réencodées en JPEG), ce qui ramène une photo de bilan de 40 Mo à moins de
-- 10 Mo sans nuire à sa lisibilité. Un PDF, lui, ne peut pas être recompressé
-- côté navigateur sans perte lourde : on l'accepte tel quel, et c'est le
-- plafond qui monte.

update storage.buckets
set file_size_limit = 52428800
where id = 'bilans';
