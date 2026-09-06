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

Render est le plus simple pour commencer.

1. Crée un compte sur https://render.com
2. Crée un dépôt GitHub et envoie le dossier `xys-book-mondial`.
3. Sur Render, clique sur **New +** puis **Blueprint**.
4. Choisis ton dépôt GitHub.
5. Render va lire `render.yaml` et créer :
   - le serveur web Node.js ;
   - la base PostgreSQL.
6. Clique sur **Apply** / **Deploy**.

Tu recevras une URL du type :

```text
https://xys-book-web.onrender.com
```

Cette adresse sera accessible depuis différents pays.

### Alternative Render manuelle

1. **New +** → **PostgreSQL**.
2. Copie l'URL `Internal Database URL`.
3. **New +** → **Web Service**.
4. Build command :

```bash
npm install
```

5. Start command :

```bash
npm start
```

6. Variables d'environnement :

```text
NODE_ENV=production
DATABASE_URL=l_url_postgresql_render
JWT_SECRET=une_tres_longue_phrase_secrete
CLIENT_ORIGIN=*
ADMIN_EMAILS=ton-email-admin@gmail.com
```

Le compte qui s'inscrit avec l'email présent dans `ADMIN_EMAILS` devient administrateur. Le tableau administrateur est disponible ici :

```text
/admin.html
```

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
