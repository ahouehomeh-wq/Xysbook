# Audit de sécurité — XyS Book Mondial

**Date :** septembre 2026
**Périmètre :** `server.js`, front-end `public/` (SPA), configuration de déploiement (`render.yaml`, `docker-compose.yml`, `.env.example`).
**Méthode :** revue de code statique + tests dynamiques sur base PostgreSQL réelle (inscription, JWT, SQL paramétré, likes, cadeaux, jetons, admin, temps réel).

> **Mise à jour — correctifs C1→C5 appliqués et testés.** Les failles critiques ci-dessous ont été corrigées dans `server.js` et revalidées par tests dynamiques (voir section 8).

---

## 1. Verdict global

> ❌ **Non, l'application n'est PAS « totalement sécurisée » et ne résisterait pas à des attaquants motivés.**
>
> Elle a une **base d'hygiène correcte** (le code n'est pas un « champ de mines » : pas d'injection SQL, mots de passe hachés, tokens JWT, protection d'accès admin, échappement XSS côté interface). Mais elle présente **plusieurs failles réelles et exploitables**, dont certaines permettent de **s'accorder soi-même un statut « premium/elite » gratuitement**, de **contourner les limites anti-abus**, et de **fuiter des conversations privées de groupes**.

**Note sur 10 : ~5/10.** Correcte pour un prototype / une démo, **insuffisante pour une mise en production publique** confrontée à de vrais acteurs malveillants.

---

## 2. Les points bien faits (fondations saines)

| Domaine | État | Détail |
|---|---|---|
| Injection SQL | ✅ | Toutes les requêtes utilisent des requêtes préparées / paramétrées (`pg`), y compris la recherche (`LIKE` paramétré). Aucun concaténation d'entrée utilisateur dans le SQL. |
| Mots de passe | ✅ | `bcryptjs` coût 12 (bon). |
| Authentification | ✅ | JWT signé (`HS256`), middleware d'auth vérifiant l'existence et la suspension du compte à chaque requête. |
| Contrôle d'accès admin | ✅ | Middleware `adminMiddleware` re-vérifie le rôle en base + bloqué si suspendu. Testé : un non-admin reçoit 403. |
| Suspension | ✅ | Un compte suspendu est refusé à la fois par l'API REST et par Socket.IO. |
| Confidentialité des e-mails | ✅ | `publicUser` vide toujours le champ email ; seuls le propriétaire (`/me`) et les admins le voient. |
| Échappement XSS (rendu) | ✅ (bon) | Le front échappe le contenu utilisateur (`esc()`) avant insertion `innerHTML`. |
| Échappement CSRF | ✅ (par design) | Auth par en-tête `Authorization: Bearer`, pas par cookie → CSRF classique largement atténué. |
| Limites anti-spam | ✅ (partiel) | Rate-limits sur auth, posts, commentaires, signalements, profil, likes, blocages, jetons, cadeaux. |
| Gestion d'erreur | ✅ | Middleware d'erreur global renvoyant un message générique 500, plus de fuite des détails internes. |
| Vérification RGPD | ✅ | Export JSON et suppression de compte avec confirmation par mot de passe, cascade `ON DELETE`. |

---

## 3. Failles critiques / élevées (à corriger avant production)

### 🔴 C1 — S'accorder soi-même le statut premium/elite gratuitement
`PATCH /api/me/subscription` permet à **tout utilisateur connecté** de passer son propre compte en `premium` ou `elite`, sans aucun paiement ni validation.
**Impact :** badge « ⭐ premium », classement prioritaire de ses publications/produits/stories, dégradation de la monétisation. C'est une faille de logique métier directe.

### 🔴 C2 — Booster son produit soi-même
`POST /api/products` lit `isBoosted` **directement depuis le corps de la requête** (`Boolean(req.body?.isBoosted)`). N'importe qui peut marquer son produit comme « boosté ».
**Impact :** concurrence déloyale, détournement du système de visibilité.

### 🔴 C3 — Contournement des limites anti-abus via `X-Forwarded-For`
Le rate-limiter prend l'adresse IP depuis `req.headers['x-forwarded-for']` **sans faire confiance au proxy** (`app.set('trust proxy', …)` absent). Un attaquant peut **envoyer un faux en-tête `X-Forwarded-For` et changer d'adresse à chaque requête**, réinitialisant ainsi son quota à l'infini (ex. : spam de posts, création de comptes en boucle).
**Impact :** neutralise la quasi-totalité des protections anti-spam/anti-brute-force.

### 🔴 C4 — Fuite de conversations privées de groupes (et de lives)
Les écouteurs Socket.IO `join-group` / `join-live` rejoignent la room **sans vérifier l'appartenance au groupe**. Le handler d'envoi (`group-message`) vérifie bien que l'*émetteur* est membre, mais **émet ensuite vers toute la room**. Un attaquant authentifié peut donc appeler `join-group` sur un id qu'il n'a pas rejoint et **recevoir tous les messages** diffusés par les membres.
**Impact :** lecture de conversations privées de groupes auxquels on n'appartient pas (fuite de données / vie privée).

### 🔴 C5 — Économie de jetons sans vrai paiement
`POST /api/me/buy-coins` crédite des jetons après validation d'un forfait… **sans aucune vérification de paiement** (pas de passerelle, pas de callback, pas de transaction côté opérateur). Combiné à C3 (multi-comptes/rate-limit contournable), on peut **générer des jetons en quantité illimitée** et les redistribuer via les cadeaux en direct.
**Impact :** économique (crédit gratuit, « pompe » sur les streamers), risque de fraude si un jour un vrai paiement est branché par-dessus sans re-conception.

---

## 4. Failles moyennes

### 🟠 M1 — Memory leak des rate-limits
`rateStore` et `socketRate` sont des `Map` **jamais purgées** : une clé par utilisateur+IP+fenêtre s'accumule indéfiniment. Sur un serveur en longue durée (ou attaqué via C3 avec des IPs multiples), **la mémoire augmente sans fin** → potentiel déni de service.

### 🟠 M2 — XSS possible (défense en profondeur faible)
- `helmet({ contentSecurityPolicy: false })` : la **CSP est désactivée**. Les entrées sont échappées, mais on n'a *aucune* barrière de secours si un point d'échappement est oublié un jour.
- Les stories acceptent `mediaUrl` **sans restriction de préfixe** (contrairement aux posts/avatars limités à `data:image/`). Une story peut pointer vers une URL externe → **pistage** (le navigateur des lecteurs la charge), voire vecteur si un jour le rendu change.

### 🟠 M3 — Token JWT stocké dans `localStorage`
Réutilisé pour l'API et Socket.IO. C'est le compromis classique d'une SPA, mais un XSS (cf. M2) ou une extension malveillante peut **voler le token**. Alternative plus sûre : cookie `httpOnly` + `SameSite`.

### 🟠 M4 — Politique de mot de passe faible & récupération fragile
- Minimum **6 caractères**, sans complexité → force brute sur la récupération, risque de casse faible.
- Récupération via **question secrète** à réponse souvent devinable (ville de naissance, par défaut) et **aucune confirmation d'e-mail** à l'inscription → **usurpation possible** d'un nom (l'e-mail est optionnel).

### 🟠 M5 — Enumération de comptes
Les messages d'erreur distincts (`Ce compte existe déjà`, `Utilisateur introuvable`, `Mot de passe incorrect`) permettent de **confirmer l'existence de comptes**.

---

## 5. Points à surveiller (mineurs / hygiène)

- **Pas de HTTPS forcé côté applicatif** (délégué à Render). OK derrière un proxy, à confirmer.
- **`CLIENT_ORIGIN=*`** dans `render.yaml` : à restreindre à ton vrai domaine en production.
- **Spam socket sur les lives** : `live-comment` / `live-frame` n'ont pas de rate-limit (contrairement aux messages privés/groupes).
- **`JWT_SECRET` généré automatiquement par Render** : bien mais à gérer en rotation.
- **En-tête `x-forwarded-for`** fiable seulement derrière un proxy configuré (sinon masquable).
- **Énumération de groupes/lives** : leurs id ne sont pas secrets ; la vraie protection doit être l'autorisation de lecture (cf. C4).

---

## 6. Plan de remédiation prioritaire

1. **C1/C2** — Retirer la possibilité de s'auto-attribuer premium/boost ; rendre ces statuts contrôlés par un vrai flux de paiement/abonnement côté serveur (et/ou par l'admin).
2. **C3/M1** — `app.set('trust proxy', 1)` derrière le proxy + utiliser la bonne adresse; purger périodiquement les `Map` de rate-limit; envisager un stockage distribué (Redis) si multi-instances.
3. **C4** — Vérifier l'appartenance (groupe/membre, live/streamer) **avant** de rejoindre une room, côté serveur.
4. **C5/M4** — Si on garde les jetons : brancher un vrai moyen de paiement validé. Sinon retirer la monétisation ou la marquer explicitement « simulation » sans valeur.
5. **M2** — Réactiver une CSP adaptée, restreindre les URLs des stories/avatars à `data:image/` (cohérence), échappement systématique.
6. **M4** — Exiger ≥ 8 caractères, vérification d'e-mail, renforcer la récupération (e-mail/OTP).
7. **M3** — Étudier le passage en cookie `httpOnly` (avec CSRF token) ou isoler le token.
8. **Divers** — Restreindre `CLIENT_ORIGIN`, activer HTTPS, surveiller la mémoire.

---

## 7. Conclusion

L'application est **techniquement propre sur l'essentiel** (aucune injection SQL, mots de passe hachés, contrôle d'accès, échappement, erreurs propres) et **convient à une démo/prototype**. Après application des correctifs C1→C5, la plupart des failles critiques sont **colmatées** (voir section 8). Il reste des points d'hygiène recommandés avant une mise en production publique (CSP, force du mot de passe, confirmation d'e-mail, cookie httpOnly).

---

## 8. Correctifs appliqués (C1→C5) — avec re-test

| # | Faille | Correction appliquée | Test |
|---|---|---|---|
| C1 | Auto-attribution premium/elite | Suppression de l'auto-abonnement ; octroi réservé à l'admin (`PATCH /admin/users/:id/subscription`). | ✅ auto → 403 ; admin octroie « elite » ; non-admin sur l'endpoint admin → 403 |
| C2 | Booster son produit soi-même | `isBoosted` est forcé à `false` côté serveur (champ client ignoré). | ✅ envoi `isBoosted:true` → stocké `false` |
| C3 | Contournement rate-limit (`X-Forwarded-For`) | `trust proxy` activable via `TRUST_PROXY` ; sinon en-tête ignoré (`getClientIp` sur `req.ip`) + purge périodique des Maps de rate-limit. | ✅ review |
| C4 | Fuite des messages de groupes / lives | Vérification d'appartenance avant `join-group` ; existence avant `join-live` ; `live-frame` réservé au streamer ; rate-limit sur `live-comment`. | ✅ test Socket.IO : non-membre reçoit une erreur et aucun message |
| C5 | Économie de jetons sans paiement | Auto-rechargement bloqué en production (flag `DEMO_TOPUP`) ; crédit de jetons et abonnement réservés à l'admin avec montants bornés. | ✅ sans `DEMO_TOPUP` → 403 ; admin crédite/abonne ; montant négatif rejeté |

**Fichiers de déploiement mis à jour :** `.env.example` (`TRUST_PROXY`, `DEMO_TOPUP=false`) et `render.yaml` (`TRUST_PROXY=1`, pas de `DEMO_TOPUP`).

### Reste à faire (recommandé avant production)
- Réactiver une **CSP** adaptée (défense en profondeur XSS).
- Exiger **≥ 8 caractères** et une **confirmation d'e-mail** à l'inscription.
- Envisager un stockage du JWT en **cookie httpOnly** (+ CSRF token) plutôt que `localStorage`.
- Restreindre `CLIENT_ORIGIN` au vrai domaine.
