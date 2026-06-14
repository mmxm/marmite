# Guide d'installation et de configuration de Yumi

**Yumi** est une application web Progressive Web App (PWA) 100% côté client (sans serveur) qui utilise **Google Drive** pour stocker vos recettes et images de manière privée, et l'**API Gemini** de Google pour importer et structurer automatiquement vos recettes à partir de liens ou de photos.

Ce guide vous explique pas à pas comment configurer les clés nécessaires pour faire fonctionner Yumi avec votre propre espace Google Drive et Gemini.

---

## 1. Création d'un ID de client Google OAuth (Requis)

Comme Yumi s'exécute entièrement dans votre navigateur (sans serveur intermédiaire), elle a besoin de votre propre identifiant d'application Google pour stocker les fichiers sur votre Google Drive.

### Étape 1 : Créer un projet sur Google Cloud
1. Rendez-vous sur la [Google Cloud Console](https://console.cloud.google.com/).
2. Connectez-vous avec votre compte Google et créez un **Nouveau projet** (ex: `Yumi Recettes`).

### Étape 2 : Activer l'API Google Drive
1. Dans la barre de recherche en haut, cherchez **Google Drive API**.
2. Cliquez sur le résultat de recherche et cliquez sur le bouton **Activer** (Enable).

### Étape 3 : Configurer l'écran de consentement OAuth
1. Dans le menu latéral de gauche, allez dans **API et services** > **Écran de consentement OAuth** (OAuth Consent Screen).
2. Sélectionnez le type d'utilisateur **Externe** (ou *Interne* si vous possédez un compte Google Workspace) et cliquez sur **Créer**.
3. Renseignez les informations de base :
   * **Nom de l'application** : `Yumi`
   * **Adresse e-mail d'assistance** : votre adresse e-mail.
   * **Coordonnées du développeur** : votre adresse e-mail.
4. Cliquez sur **Enregistrer et continuer**.
5. Dans l'étape **Champs d'application** (Scopes), cliquez sur **Ajouter ou supprimer des champs**. Renseignez la ligne suivante dans le champ d'ajout manuel ou cochez-la :
   * `.../auth/drive.file` *(Permet à Yumi d'accéder uniquement aux fichiers et dossiers qu'elle a elle-même créés).*
6. Dans l'étape **Utilisateurs de test** (Test users), ajoutez impérativement votre propre adresse e-mail Google (ainsi que les e-mails de tous les comptes que vous souhaitez connecter à l'application).
7. Enregistrez et validez.

### Étape 4 : Créer les identifiants OAuth Client ID
1. Dans le menu latéral de gauche, allez dans **Identifiants** (Credentials).
2. Cliquez sur **Créer des identifiants** > **ID de client OAuth** (OAuth Client ID).
3. Sélectionnez **Application Web** comme type d'application.
4. Donnez-lui un nom (ex: `Yumi PWA`).
5. Dans la section **Origines JavaScript autorisées** (Authorized JavaScript origins), ajoutez les adresses depuis lesquelles vous allez charger l'application :
   * Pour vos tests locaux : `http://localhost:8000` et `http://127.0.0.1:8000`.
   * Pour votre déploiement en ligne : `https://yumi42.vercel.app` (à adapter avec votre adresse Vercel ou d'hébergement).
6. Laissez la section *URI de redirection autorisés* vide (Yumi utilise le flux d'authentification implicite direct).
7. Cliquez sur **Créer**.
8. Copiez l'**ID de client** généré (qui ressemble à `xxxxxxxxx-xxxxxxxxxx.apps.googleusercontent.com`).
9. Ouvrez votre application Yumi, accédez à la section **Paramètres** (icône d'engrenage), collez l'ID dans le champ **Google Client ID** puis cliquez sur **Se connecter avec Google**.

---

## 2. Clé d'API Gemini pour l'IA (Recommandé)

L'API Gemini est requise pour analyser les photos de recettes papier et pour servir de solution de secours (fallback) sur les sites web ne disposant pas de métadonnées structurées lors d'un import par lien.

1. Rendez-vous sur [Google AI Studio](https://aistudio.google.com/).
2. Cliquez sur le bouton **Get API key** (Obtenir une clé d'API).
3. Créez une clé d'API dans un nouveau projet et copiez-la.
4. Renseignez cette clé dans le champ **Clé d'API Gemini** des paramètres de Yumi.

---

## 3. Déploiement du Serveur Proxy Google Apps Script (Optionnel)

Pour contourner les blocages de sécurité (CORS) et anti-robots de certains sites de recettes (comme Marmiton) et récupérer proprement les photos, vous pouvez déployer le script proxy inclus à la racine de votre projet :

1. Ouvrez [Google Apps Script](https://script.google.com).
2. Créez un **Nouveau projet**.
3. Copiez le contenu du fichier `yumi-proxy.js` (ou `marmite-proxy.js`) situé à la racine de votre projet et collez-le dans l'éditeur de code (en remplaçant le code existant).
4. **Sécurité & Clés (Optionnel mais recommandé) :**
   Dans les **Paramètres de votre projet** Apps Script (icône d'engrenage à gauche), faites défiler jusqu'à la section **Propriétés du script** et ajoutez ces deux variables :
   * `GEMINI_API_KEY` : Votre clé d'API Gemini (Yumi pourra ainsi l'utiliser de façon sécurisée).
   * `ACCESS_TOKEN` : Un mot de passe de votre choix (ex: `MonSecretRecette123`). Si configuré, le proxy refusera toutes les requêtes n'ayant pas ce jeton. Renseignez alors ce même mot de passe dans le champ **Jeton de sécurité du proxy** dans les paramètres de Yumi.
5. Cliquez sur **Déployer** > **Nouveau déploiement** (en haut à droite) :
   * Sélectionnez le type **Application Web** (via l'icône d'engrenage à côté de "Sélectionner un type").
   * **Exécuter en tant que** : Sélectionnez **Moi (votre-email@gmail.com)**.
   * **Qui a accès** : Sélectionnez **Tout le monde** (requis pour que votre navigateur puisse l'appeler).
6. Cliquez sur **Déployer**, validez les autorisations d'accès Google, puis copiez l'**URL de l'application web** générée (se terminant par `/exec`).
7. Collez cette URL dans le champ **URL de la Web App Google Apps Script** des paramètres de Yumi.

---

## 4. Démarrage local et Déploiement

### Lancement Local
Pour exécuter l'application sur votre ordinateur :
1. Ouvrez un terminal dans le répertoire du projet.
2. Démarrez un serveur HTTP local léger (par exemple avec Python) :
   ```bash
   python3 -m http.server 8000
   ```
3. Ouvrez votre navigateur sur `http://localhost:8000`.

### Déploiement Vercel / Netlify
Comme Yumi est une application statique sans base de données serveur, vous pouvez la déployer gratuitement en quelques secondes sur Vercel, Netlify ou GitHub Pages en important simplement les fichiers du répertoire.
