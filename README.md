# XyS Book Mondial

Application sociale mondiale avec serveur Node.js, chat temps réel et vraie base de données PostgreSQL.

## Ce qui est déjà prêt

- Inscription / connexion avec JWT.
- Mots de passe hachés avec bcrypt.
- Base de données PostgreSQL.
- Publications mondiales en temps réel.
- Commentaires sous les publications.
- Photos de profil.
- Liste des utilisateurs.
- Messages privés en temps réel avec Socket.IO.
- Blocage d'utilisateurs.
- Signalement d'utilisateurs ou de publications.
- Tableau administrateur pour gérer signalements, utilisateurs, publications et commentaires.
- Journal des actions administrateur.
- Raison de suspension.
- Limites anti-spam.
- Pages conditions, confidentialité et règles de communauté.
- **Exportation des données personnelles (portabilité RGPD)** sous format JSON.
- **Suppression définitive du compte et de toutes ses données (droit à l'effacement)** avec confirmation par mot de passe.
- Interface responsive téléphone / ordinateur.
- Configuration prête pour Render.

---

## 1. Tester en local

### Option simple avec Docker

Installe Docker Desktop puis lance PostgreSQL :

```bash
cd xys-book-mondial
docker compose up -d
```

Copie le fichier d'environnement :

```bash
cp .env.example .env
```

Installe les dépendances :

```bash
npm install
```

Lance l'application :

```bash
npm start
```

Ouvre :

```text
http://localhost:3000
```

### Sans Docker

Crée une base PostgreSQL appelée `xys_book`, puis mets ton lien PostgreSQL dans `.env` :

```text
DATABASE_URL=postgresql://utilisateur:motdepasse@localhost:5432/xys_book
JWT_SECRET=une-longue-phrase-secrete
ADMIN_EMAILS=ton-email-admin@gmail.com
```

Puis :

```bash
npm install
npm start
```

Le serveur crée automatiquement les tables au démarrage.

---

## 2. Publier mondialement avec Render

Le dépôt contient déjà un `render.yaml` : Render peut créer automatiquement le serveur web Node.js **et** la base PostgreSQL.

### Prérequis

- Le code est sur **GitHub** (branche `main`).
- Un compte [Render](https://render.com) (gratuit suffit pour tester).

### Méthode A — Blueprint (recommandée, 5 minutes)

1. Sur [dashboard.render.com](https://dashboard.render.com), connecte ton compte GitHub si ce n'est pas fait.
2. Clique sur **New + → Blueprint**.
3. Sélectionne le dépôt `Xysbook` (le fichier `render.yaml` est à la racine).
4. Vérifie que la **branche `main`** est bien sélectionnée, puis clique sur **Apply**.
5. Render crée alors :
   - `xys-book-web` — le serveur Node.js (plan **Free**) ;
   - `xys-book-db` — la base PostgreSQL (plan **Free**).
6. Laisse le déploiement se terminer (~2-3 min). L'application est ensuite disponible à une URL du type :

```text
https://xys-book-web.onrender.com
```

7. **Après le déploiement**, ouvre le service `xys-book-web → Environment` et remplace la valeur par défaut :

```text
ADMIN_EMAILS=change-moi@email.com
```

par ton e-mail (ex. `ton-email@gmail.com`). Le compte qui s'inscrit avec cet e-mail devient administrateur.
Les valeurs `JWT_SECRET` et `DATABASE_URL` sont générées automatiquement par le Blueprint : tu n'as rien à saisir.

8. Vérifie le bon fonctionnement :

```text
https://xys-book-web.onrender.com/api/health   → { "ok": true, "database": "connected", ... }
https://xys-book-web.onrender.com              → page de connexion
https://xys-book-web.onrender.com/admin.html   → panneau admin (après inscription avec l'e-mail admin)
```

> 💡 **Tu peux aussi lancer tous les services à la fois** : `blueprint` propose un bouton **Deploy** pour tout le Blueprint. Le `render.yaml` configure aussi un **health check** sur `/api/health` : Render redémarre le service si la base devient injoignable.

### Méthode B — Manuel (sans `render.yaml`)

1. **New + → PostgreSQL** → crée la base (plan Free) et note l'**Internal Database URL**.
2. **New + → Web Service** → connecte le dépôt GitHub, branche `main`.
3. Dans le service web :
   - **Build command** : `npm ci`
   - **Start command** : `npm start`
4. Ajoute les variables d'environnement suivantes :

| Variable | Valeur | Note |
|---|---|---|
| `NODE_ENV` | `production` | Active SSL PostgreSQL côté serveur |
| `DATABASE_URL` | l'URL de la base Render | Référence la base créée à l'étape 1 |
| `JWT_SECRET` | une très longue phrase aléatoire | Ex. : `openssl rand -hex 48` |
| `CLIENT_ORIGIN` | `*` (démo) ou ton domaine | `*` bloque les cookies cross-origin ; mets ton domaine en prod |
| `ADMIN_EMAILS` | `ton-email@gmail.com` | E-mails séparés par des virgules |
| `TRUST_PROXY` | `1` | Requis derrière le proxy de Render |
| `DEMO_TOPUP` | `false` (ou vide) | **Jamais** `true` en production : autoriserait d'auto-créditer des jetons |

### Limites du plan Free à connaître

- Le service web **se met en veille après 15 min sans trafic** ; au premier clic, le redémarrage prend ~1 min.
- La base PostgreSQL gratuite **expire au bout de 30 jours** (elle est alors supprimée). Pour une production durable, passe la base en plan payant ou prévois une migration.
- Le disque est **éphémère** : les données doivent être en base (c'est le cas ici), pas dans des fichiers locaux. Les images envoyées sont stockées en base, donc elles sont conservées.
- 750 heures d'instance gratuites par mois pour tous les services web gratuits.

### Avant un lancement public

- Mets `CLIENT_ORIGIN` sur ton vrai domaine (ex. `https://ton-domaine.com`) et ajoute-le dans le service Render.
- Vérifie que `DEMO_TOPUP` est bien vide/false et que `ADMIN_EMAILS` contient ton e-mail.
- Ajoute les pages légales (déjà présentes : `/conditions.html`, `/confidentialite.html`, `/regles.html`) et une politique complète si nécessaire.

---

## 3. Suggestions pour finaliser l'application

### Priorité 1 — indispensable avant lancement public

- Ajouter une page **conditions d'utilisation** et **politique de confidentialité**.
- Ajouter une fonction **signaler un utilisateur / message**.
- Ajouter une fonction **bloquer un utilisateur**.
- Ajouter une modération simple pour supprimer les contenus dangereux.
- Mettre `CLIENT_ORIGIN` avec ton vrai domaine au lieu de `*`.

### Priorité 2 — rendre l'application plus agréable

- Photos de profil.
- Envoi d'images dans les publications.
- Commentaires sous les posts.
- Notifications de nouveaux messages.
- Recherche d'utilisateurs par pays.
- Groupes de discussion.
- Statut “en ligne / hors ligne” plus précis.

### Priorité 3 — croissance

- Stockage d'images avec Cloudinary, S3 ou Supabase Storage.
- Email de confirmation avec Brevo, SendGrid ou Resend.
- Réinitialisation de mot de passe.
- Tableau admin.
- Sauvegardes automatiques de la base de données.

---

## 4. Structure du projet

```text
xys-book-mondial/
  server.js              # serveur API + Socket.IO + PostgreSQL
  package.json           # dépendances Node.js
  render.yaml            # déploiement Render
  docker-compose.yml     # PostgreSQL local
  .env.example           # exemple de configuration
  .gitignore             # ignore .env et node_modules
  public/
    index.html           # interface utilisateur (SPA)
    app.css              # styles de l'interface
    app.js               # logique de l'interface (temps réel)
    admin.html           # tableau administrateur (/admin.html)
    admin.css            # styles du panneau admin
    admin.js             # logique du panneau admin
    conditions.html      # conditions d'utilisation
    confidentialite.html # politique de confidentialité
    regles.html          # règles de la communauté
    legal.css            # styles des pages légales
```

---

## 5. Correctifs de sécurité appliqués

- **Rechargement de jetons sécurisé** : seuls des forfaits validés côté serveur sont acceptés (+ limitation de débit).
- **Cadeaux (directs)** : le prix vient d'un catalogue serveur, les quantités négatives/abusives sont rejetées et le débit est atomique.
- **J'aime dédoublonnés** : table `post_likes` empêchant d'aimer une publication en boucle (fini l'inflation des compteurs).
- **Suppression possible** de ses propres publications et commentaires.
- **Validation** du format des e-mails.
- **Rate-limits** ajoutés sur les likes, blocages, rechargements et cadeaux.
- **Middleware d'erreur global** et réponses JSON 404 pour l'API (pas de fuite de détails internes).
- **CSP** (Content-Security-Policy) via helmet.
- **JWT en cookie `httpOnly`** (plus de token en `localStorage`) + support Bearer conservé.
- **Mot de passe ≥ 8 caractères** (lettre + chiffre) et **e-mail obligatoire** à l'inscription.
- **Abonnements premium/elite et crédits de jetons réservés à l'admin** ; rechargement libre soumis au flag `DEMO_TOPUP`.

## 6. Important sécurité

Ne mets jamais ton vrai fichier `.env` sur GitHub (il est désormais ignoré par `.gitignore`).

Change toujours :

```text
JWT_SECRET
```

avec une phrase très longue et difficile à deviner.
