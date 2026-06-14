/* ==========================================================================
   APP STATE & INITIALIZATION
   ========================================================================== */

const state = {
  recipes: [],
  config: {
    googleClientId: '',
    geminiApiKey: '',
    folderId: '',
    accessToken: '',
    tokenExpiresAt: 0,
    userEmail: ''
  },
  activeView: 'catalog',
  activeRecipe: null,
  servingsMultiplier: 1,
  cookingModeActive: false,
  activeStepIndex: 0,
  selectedImageBlob: null,
  activeCategory: 'Tous'
};

// CORS Proxy for URL Scraping
const CORS_PROXY = 'https://api.allorigins.win/get?url=';

// Initialize App
window.addEventListener('DOMContentLoaded', () => {
  app.init();
});

const app = {
  // --- Lifecyle ---
  async init() {
    this.registerServiceWorker();
    this.loadConfig();
    this.initIndexedDB();
    this.setupEventListeners();
    this.checkGoogleSession();
    
    // Initial Route
    this.navigate('catalog');
    
    // Try to load cached recipes first
    await this.loadCachedRecipes();
    
    // Check if Google Drive is configured (needs client ID)
    if (!state.config.googleClientId) {
      this.showToast('Veuillez renseigner votre Google Client ID dans les paramètres', 'warning');
      this.navigate('settings');
    } else {
      if (this.isUserConnected()) {
        await this.syncData();
      } else {
        this.showToast('Google Drive non connecté. Session expirée ou non démarrée.', 'info');
      }
    }
    this.hideLoader();
  },

  registerServiceWorker() {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js')
        .then(() => console.log('[PWA] Service Worker registered'))
        .catch(err => console.error('[PWA] Service Worker registration failed', err));
    }
  },

  loadConfig() {
    const saved = localStorage.getItem('marmite_config');
    if (saved) {
      state.config = { ...state.config, ...JSON.parse(saved) };
    }
    
    // Populate form fields in Settings
    document.getElementById('setting-client-id').value = state.config.googleClientId || '';
    document.getElementById('setting-gemini-key').value = state.config.geminiApiKey || '';
  },

  saveSettings() {
    state.config.googleClientId = document.getElementById('setting-client-id').value.trim();
    state.config.geminiApiKey = document.getElementById('setting-gemini-key').value.trim();
    
    localStorage.setItem('marmite_config', JSON.stringify({
      googleClientId: state.config.googleClientId,
      geminiApiKey: state.config.geminiApiKey,
      folderId: state.config.folderId,
      userEmail: state.config.userEmail
    }));
    this.showToast('Paramètres enregistrés en local', 'success');
  },

  setupEventListeners() {
    // Add close dialog listeners or clean search keys
    document.getElementById('search-input').addEventListener('keyup', (e) => {
      const clearBtn = document.getElementById('search-clear');
      if (e.target.value.trim().length > 0) {
        clearBtn.classList.remove('hidden');
      } else {
        clearBtn.classList.add('hidden');
      }
    });
  },

  // --- IndexedDB Cache for Private Images ---
  db: null,
  initIndexedDB() {
    const request = indexedDB.open('MarmiteImageCache', 1);
    request.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('images')) {
        db.createObjectStore('images');
      }
    };
    request.onsuccess = (e) => {
      this.db = e.target.result;
    };
    request.onerror = (e) => {
      console.error('IndexedDB error', e);
    };
  },

  cacheImage(fileId, blob) {
    if (!this.db) return;
    const transaction = this.db.transaction(['images'], 'readwrite');
    const store = transaction.objectStore('images');
    store.put(blob, fileId);
  },

  getCachedImage(fileId) {
    return new Promise((resolve) => {
      if (!this.db) return resolve(null);
      const transaction = this.db.transaction(['images'], 'readonly');
      const store = transaction.objectStore('images');
      const request = store.get(fileId);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => resolve(null);
    });
  },

  clearIndexedDB() {
    if (!this.db) return;
    const transaction = this.db.transaction(['images'], 'readwrite');
    const store = transaction.objectStore('images');
    store.clear();
  },

  // --- Routing & Views ---
  navigate(viewId) {
    state.activeView = viewId;
    
    // Update views classes
    document.querySelectorAll('.app-view').forEach(view => {
      view.classList.remove('active');
    });
    
    const target = document.getElementById(`view-${viewId}`);
    if (target) {
      target.classList.add('active');
    }
    
    // Customize page header or scroll resets
    window.scrollTo(0, 0);
    this.updateHeaderState();
  },

  updateHeaderState() {
    const header = document.querySelector('.app-header');
    if (state.activeView === 'detail' || state.activeView === 'form') {
      header.classList.add('hidden');
    } else {
      header.classList.remove('hidden');
    }
  },

  // --- Google Drive Authentication ---
  tokenClient: null,

  checkGoogleSession() {
    const savedToken = localStorage.getItem('gdrive_access_token');
    const expiresAt = localStorage.getItem('gdrive_token_expires_at');
    
    if (savedToken && expiresAt && Date.now() < parseInt(expiresAt)) {
      state.config.accessToken = savedToken;
      state.config.tokenExpiresAt = parseInt(expiresAt);
      this.updateGoogleUI(true);
    } else {
      this.updateGoogleUI(false);
    }
  },

  isUserConnected() {
    return !!state.config.accessToken && Date.now() < state.config.tokenExpiresAt;
  },

  loginGoogleDrive() {
    if (!state.config.googleClientId) {
      this.showToast('Veuillez renseigner votre Google Client ID dans les paramètres', 'error');
      return;
    }
    
    this.showLoader('Connexion à Google Drive...');
    
    try {
      this.tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: state.config.googleClientId,
        scope: 'https://www.googleapis.com/auth/drive.file',
        callback: async (tokenResponse) => {
          if (tokenResponse.error !== undefined) {
            this.hideLoader();
            this.showToast(`Erreur d'authentification : ${tokenResponse.error}`, 'error');
            return;
          }
          
          state.config.accessToken = tokenResponse.access_token;
          state.config.tokenExpiresAt = Date.now() + tokenResponse.expires_in * 1000;
          
          localStorage.setItem('gdrive_access_token', tokenResponse.access_token);
          localStorage.setItem('gdrive_token_expires_at', state.config.tokenExpiresAt);
          
          this.updateGoogleUI(true);
          this.showToast('Connecté à Google Drive avec succès !', 'success');
          
          // Sync database folder
          await this.syncData();
          this.hideLoader();
        },
      });
      
      this.tokenClient.requestAccessToken({ prompt: 'consent' });
    } catch (err) {
      this.hideLoader();
      console.error(err);
      this.showToast('Échec de la connexion Google Client SDK', 'error');
    }
  },

  logoutGoogleDrive() {
    if (state.config.accessToken) {
      google.accounts.oauth2.revokeToken(state.config.accessToken, () => {
        state.config.accessToken = '';
        state.config.tokenExpiresAt = 0;
        localStorage.removeItem('gdrive_access_token');
        localStorage.removeItem('gdrive_token_expires_at');
        this.updateGoogleUI(false);
        this.showToast('Déconnecté de Google Drive', 'info');
      });
    }
  },

  updateGoogleUI(isConnected) {
    const disconnectedBox = document.getElementById('gdrive-status-disconnected');
    const connectedBox = document.getElementById('gdrive-status-connected');
    const loginBtn = document.getElementById('btn-gdrive-login');
    const logoutBtn = document.getElementById('btn-gdrive-logout');
    const syncBtn = document.getElementById('btn-sync');

    if (isConnected) {
      disconnectedBox.classList.add('hidden');
      connectedBox.classList.remove('hidden');
      loginBtn.classList.add('hidden');
      logoutBtn.classList.remove('hidden');
      syncBtn.classList.remove('hidden');
      
      // Basic fetch to get user email from token (optional)
      document.getElementById('gdrive-user-email').textContent = 'Accès Google Drive Actif';
    } else {
      disconnectedBox.classList.remove('hidden');
      connectedBox.classList.add('hidden');
      loginBtn.classList.remove('hidden');
      logoutBtn.classList.add('hidden');
      syncBtn.classList.add('hidden');
    }
  },

  async refreshTokenIfNeeded() {
    if (!this.isUserConnected() && state.config.googleClientId) {
      // Prompt user or try silent login
      return new Promise((resolve, reject) => {
        try {
          this.tokenClient = google.accounts.oauth2.initTokenClient({
            client_id: state.config.googleClientId,
            scope: 'https://www.googleapis.com/auth/drive.file',
            callback: (tokenResponse) => {
              if (tokenResponse.error) return reject(tokenResponse.error);
              state.config.accessToken = tokenResponse.access_token;
              state.config.tokenExpiresAt = Date.now() + tokenResponse.expires_in * 1000;
              localStorage.setItem('gdrive_access_token', tokenResponse.access_token);
              localStorage.setItem('gdrive_token_expires_at', state.config.tokenExpiresAt);
              this.updateGoogleUI(true);
              resolve();
            }
          });
          this.tokenClient.requestAccessToken({ prompt: '' }); // Silent request
        } catch (err) {
          reject(err);
        }
      });
    }
  },

  // --- Google Drive REST API Calls ---
  async driveRequest(url, options = {}) {
    await this.refreshTokenIfNeeded();
    if (!state.config.accessToken) {
      throw new Error('Non connecté à Google Drive');
    }
    
    const headers = options.headers || {};
    headers['Authorization'] = `Bearer ${state.config.accessToken}`;
    options.headers = headers;
    
    const response = await fetch(url, options);
    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Erreur API Google Drive (${response.status}) : ${errText}`);
    }
    return response;
  },

  async syncData() {
    if (!this.isUserConnected()) {
      this.showToast('Veuillez d\'abord vous connecter à Google Drive', 'warning');
      return;
    }
    
    this.showLoader('Synchronisation en cours...');
    try {
      // 1. Get or create app folder
      if (!state.config.folderId) {
        state.config.folderId = await this.findOrCreateAppFolder();
        this.saveSettings();
      }
      
      // 2. Find or create recipes.json
      const fileId = await this.findRecipesFileId(state.config.folderId);
      if (fileId) {
        // Download recipes from Google Drive
        const gRecipes = await this.downloadRecipesFile(fileId);
        state.recipes = gRecipes || [];
        this.saveRecipesLocally();
      } else {
        // Upload local recipes to Google Drive
        await this.uploadRecipesFile(state.config.folderId);
      }
      
      this.renderCatalog();
      this.showToast('Synchronisation réussie !', 'success');
      document.getElementById('stats-last-sync').textContent = new Date().toLocaleTimeString();
    } catch (err) {
      console.error(err);
      this.showToast(`Échec de la synchronisation : ${err.message}`, 'error');
    } finally {
      this.hideLoader();
    }
  },

  async findOrCreateAppFolder() {
    const q = encodeURIComponent("name='PWA_Recipe_Manager' and mimeType='application/vnd.google-apps.folder' and trashed=false");
    const response = await this.driveRequest(`https://www.googleapis.com/drive/v3/files?q=${q}`);
    const data = await response.json();
    
    if (data.files && data.files.length > 0) {
      return data.files[0].id;
    }
    
    // Create new folder
    const createResp = await this.driveRequest('https://www.googleapis.com/drive/v3/files', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'PWA_Recipe_Manager',
        mimeType: 'application/vnd.google-apps.folder'
      })
    });
    const folder = await createResp.json();
    return folder.id;
  },

  async findRecipesFileId(folderId) {
    const q = encodeURIComponent(`name='recipes.json' and '${folderId}' in parents and trashed=false`);
    const response = await this.driveRequest(`https://www.googleapis.com/drive/v3/files?q=${q}`);
    const data = await response.json();
    return (data.files && data.files.length > 0) ? data.files[0].id : null;
  },

  async downloadRecipesFile(fileId) {
    const response = await this.driveRequest(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`);
    return await response.json();
  },

  async uploadRecipesFile(folderId) {
    const fileId = await this.findRecipesFileId(folderId);
    const bodyContent = JSON.stringify(state.recipes);
    
    if (fileId) {
      // Update existing file
      await this.driveRequest(`https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: bodyContent
      });
    } else {
      // Create new file metadata first
      const metaResp = await this.driveRequest('https://www.googleapis.com/drive/v3/files', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'recipes.json',
          parents: [folderId],
          mimeType: 'application/json'
        })
      });
      const newFile = await metaResp.json();
      
      // Upload content
      await this.driveRequest(`https://www.googleapis.com/upload/drive/v3/files/${newFile.id}?uploadType=media`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: bodyContent
      });
    }
  },

  // Upload an image file to Google Drive and return the File ID
  async uploadImageToDrive(blob, name = 'recipe_image.jpg') {
    if (!state.config.folderId) {
      state.config.folderId = await this.findOrCreateAppFolder();
    }
    
    // 1. Create file metadata
    const metaResp = await this.driveRequest('https://www.googleapis.com/drive/v3/files', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: name,
        parents: [state.config.folderId],
        mimeType: 'image/jpeg'
      })
    });
    const imgFile = await metaResp.json();
    
    // 2. Upload binary content
    await this.driveRequest(`https://www.googleapis.com/upload/drive/v3/files/${imgFile.id}?uploadType=media`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'image/jpeg' },
      body: blob
    });
    
    // Cache the uploaded blob locally as well
    this.cacheImage(imgFile.id, blob);
    
    return imgFile.id;
  },

  // Fetch image from Google Drive and render to <img> element
  async displayDriveImage(fileId, imgElementId) {
    const imgEl = document.getElementById(imgElementId);
    if (!imgEl) return;
    
    // If it's a local asset path (from imported Mealie ZIP backup), display directly
    if (fileId.startsWith('images/') || fileId.includes('.webp') || fileId.includes('.jpg') || fileId.includes('.png')) {
      imgEl.src = fileId;
      return;
    }
    
    // 1. Check local IndexedDB cache first
    const cachedBlob = await this.getCachedImage(fileId);
    if (cachedBlob) {
      imgEl.src = URL.createObjectURL(cachedBlob);
      return;
    }
    
    // 2. If online and not cached, download it
    if (this.isUserConnected()) {
      try {
        const response = await this.driveRequest(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`);
        const blob = await response.blob();
        
        // Cache for future offline usage
        this.cacheImage(fileId, blob);
        
        imgEl.src = URL.createObjectURL(blob);
      } catch (err) {
        console.error('Failed to load image from GDrive', err);
        imgEl.src = this.getRecipeSVGPlaceholder(); // Fallback
      }
    } else {
      imgEl.src = this.getRecipeSVGPlaceholder(); // Offline fallback
    }
  },

  // --- Local Offline Cache ---
  async loadCachedRecipes() {
    const cached = localStorage.getItem('marmite_recipes_cache');
    if (cached) {
      const parsed = JSON.parse(cached);
      if (parsed && parsed.length > 0) {
        state.recipes = parsed;
        this.renderCatalog();
        return;
      }
    }
    
    // Fallback: fetch recipes.json if cache is missing or empty
    try {
      const response = await fetch('recipes.json?t=' + Date.now());
      if (response.ok) {
        state.recipes = await response.json();
        this.saveRecipesLocally();
        this.renderCatalog();
      }
    } catch (err) {
      console.log('No default recipes.json found', err);
    }
  },

  saveRecipesLocally() {
    localStorage.setItem('marmite_recipes_cache', JSON.stringify(state.recipes));
    document.getElementById('stats-local-count').textContent = state.recipes.length;
  },

  clearLocalCache() {
    localStorage.removeItem('marmite_recipes_cache');
    state.recipes = [];
    this.clearIndexedDB();
    this.renderCatalog();
    document.getElementById('stats-local-count').textContent = 0;
    this.showToast('Données et photos effacées du cache local', 'info');
  },

  async importLocalRecipesFile() {
    this.showLoader('Importation des recettes de sauvegarde...');
    try {
      const response = await fetch('recipes.json?t=' + Date.now());
      if (response.ok) {
        const data = await response.json();
        if (data && data.length > 0) {
          state.recipes = data;
          this.saveRecipesLocally();
          this.renderCatalog();
          this.showToast(`${data.length} recettes importées avec succès !`, 'success');
        } else {
          this.showToast('Le fichier recipes.json est vide.', 'warning');
        }
      } else {
        throw new Error(`Erreur HTTP ${response.status}`);
      }
    } catch (err) {
      console.error(err);
      this.showToast('Impossible de charger recipes.json : ' + err.message, 'error');
    } finally {
      this.hideLoader();
    }
  },

  // --- Catalog Rendering & Filtering ---
  renderCatalog() {
    const grid = document.getElementById('recipes-grid');
    const emptyState = document.getElementById('catalog-empty-state');
    grid.innerHTML = '';
    
    // Gather categories
    const categories = ['Tous', ...new Set(state.recipes.map(r => r.category || 'Autre'))];
    this.renderCategoryPills(categories);

    // Apply Search & Filters
    const query = document.getElementById('search-input').value.toLowerCase().trim();
    
    const filtered = state.recipes.filter(recipe => {
      const matchesCategory = state.activeCategory === 'Tous' || (recipe.category || 'Autre') === state.activeCategory;
      
      const titleMatch = recipe.title.toLowerCase().includes(query);
      const descMatch = (recipe.description || '').toLowerCase().includes(query);
      const ingredientMatch = (recipe.ingredients || []).some(ing => ing.name.toLowerCase().includes(query));
      const tagMatch = (recipe.tags || []).some(tag => tag.toLowerCase().includes(query));
      
      const matchesSearch = !query || titleMatch || descMatch || ingredientMatch || tagMatch;
      
      return matchesCategory && matchesSearch;
    });

    if (filtered.length === 0) {
      grid.classList.add('hidden');
      emptyState.classList.remove('hidden');
      return;
    }
    
    grid.classList.remove('hidden');
    emptyState.classList.add('hidden');

    filtered.forEach(recipe => {
      const card = document.createElement('div');
      card.className = 'recipe-card';
      card.onclick = () => this.openRecipeDetail(recipe.id);
      
      const imgId = `card-img-${recipe.id}`;
      
      card.innerHTML = `
        <div class="recipe-card-img-wrapper">
          <img id="${imgId}" src="${this.getRecipeSVGPlaceholder()}" alt="${recipe.title}" class="recipe-card-img">
          <span class="recipe-card-category">${recipe.category || 'Plat'}</span>
        </div>
        <div class="recipe-card-info">
          <h4 class="recipe-card-title">${recipe.title}</h4>
          <div class="recipe-card-meta">
            <span class="recipe-card-time">
              <i class="fa-regular fa-clock"></i> ${recipe.prepTime + recipe.cookTime} min
            </span>
            <span>${recipe.ingredients ? recipe.ingredients.length : 0} ingr.</span>
          </div>
        </div>
      `;
      
      grid.appendChild(card);
      
      // Load image asynchronously
      if (recipe.imageId) {
        this.displayDriveImage(recipe.imageId, imgId);
      } else {
        document.getElementById(imgId).src = this.getRecipeSVGPlaceholder();
      }
    });

    document.getElementById('stats-local-count').textContent = state.recipes.length;
  },

  renderCategoryPills(categories) {
    const list = document.getElementById('categories-list');
    list.innerHTML = '';
    
    categories.forEach(cat => {
      const pill = document.createElement('button');
      pill.className = `category-pill ${state.activeCategory === cat ? 'active' : ''}`;
      pill.textContent = cat;
      pill.onclick = () => {
        state.activeCategory = cat;
        this.renderCatalog();
      };
      list.appendChild(pill);
    });
  },

  filterRecipes() {
    this.renderCatalog();
  },

  clearSearch() {
    const input = document.getElementById('search-input');
    input.value = '';
    document.getElementById('search-clear').classList.add('hidden');
    this.renderCatalog();
  },

  // --- Recipe Detail Operations ---
  openRecipeDetail(recipeId) {
    const recipe = state.recipes.find(r => r.id === recipeId);
    if (!recipe) return;
    
    state.activeRecipe = recipe;
    state.servingsMultiplier = 1; // reset servings
    state.cookingModeActive = false;
    document.getElementById('toggle-cooking-mode').checked = false;
    
    // Fill basic details
    document.getElementById('detail-title').textContent = recipe.title;
    document.getElementById('detail-description').textContent = recipe.description || 'Pas de description';
    document.getElementById('detail-prep-time').textContent = `${recipe.prepTime || 0} min`;
    document.getElementById('detail-cook-time').textContent = `${recipe.cookTime || 0} min`;
    document.getElementById('detail-category').textContent = recipe.category || 'Autre';
    document.getElementById('detail-servings-value').textContent = recipe.servings || 4;
    
    // Load Tags
    const tagsContainer = document.getElementById('detail-tags');
    tagsContainer.innerHTML = '';
    if (recipe.tags && recipe.tags.length > 0) {
      recipe.tags.forEach(tag => {
        if (!tag.trim()) return;
        const span = document.createElement('span');
        span.className = 'tag-badge';
        span.textContent = tag;
        tagsContainer.appendChild(span);
      });
    }

    // Bind Edit/Delete Buttons
    document.getElementById('btn-edit-recipe').onclick = () => this.openEditRecipeForm(recipe.id);
    document.getElementById('btn-delete-recipe').onclick = () => this.deleteRecipe(recipe.id);
    
    // Load image
    const heroImg = document.getElementById('detail-image');
    if (recipe.imageId) {
      heroImg.src = this.getRecipeSVGPlaceholder(); // temporary
      this.displayDriveImage(recipe.imageId, 'detail-image');
    } else {
      heroImg.src = this.getRecipeSVGPlaceholder();
    }
    
    // Render tabs list
    this.switchRecipeTab('ingredients');
    this.renderIngredientsList();
    this.renderStepsList();
    
    this.navigate('detail');
  },

  switchRecipeTab(tabId) {
    document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));
    
    document.getElementById(`tab-btn-${tabId}`).classList.add('active');
    document.getElementById(`tab-${tabId}`).classList.add('active');
  },

  changeServings(delta) {
    const servingsVal = document.getElementById('detail-servings-value');
    let current = parseInt(servingsVal.textContent);
    current += delta;
    if (current < 1) return;
    
    servingsVal.textContent = current;
    
    // Compute serving multiplier
    const originalServings = state.activeRecipe.servings || 4;
    state.servingsMultiplier = current / originalServings;
    
    // Rerender ingredients to adjust quantities
    this.renderIngredientsList();
  },

  renderIngredientsList() {
    const list = document.getElementById('detail-ingredients-list');
    list.innerHTML = '';
    
    const ingredients = state.activeRecipe.ingredients || [];
    document.getElementById('detail-ingredients-count').textContent = ingredients.length;
    
    ingredients.forEach((ing, index) => {
      const li = document.createElement('li');
      li.className = 'ingredient-item';
      li.onclick = () => li.classList.toggle('checked');
      
      let qtyStr = '';
      if (ing.quantity) {
        // Compute adjusted quantity
        const adjustedQty = ing.quantity * state.servingsMultiplier;
        // Format nicely: e.g. 1.5 -> 1.5, 2.0 -> 2
        qtyStr = `<span class="ingredient-qty">${parseFloat(adjustedQty.toFixed(2))}</span>`;
      }
      
      li.innerHTML = `
        <div class="ingredient-checkbox">
          <i class="fa-solid fa-check"></i>
        </div>
        <div class="ingredient-content">
          ${qtyStr}${ing.unit ? ing.unit + ' ' : ''}${ing.name}
        </div>
      `;
      list.appendChild(li);
    });
  },

  renderStepsList() {
    const list = document.getElementById('detail-steps-list');
    list.innerHTML = '';
    
    const steps = state.activeRecipe.steps || [];
    document.getElementById('detail-steps-count').textContent = steps.length;
    
    steps.forEach((step, index) => {
      const card = document.createElement('div');
      card.className = 'step-card';
      card.id = `step-card-${index}`;
      card.onclick = () => this.handleStepClick(index);
      
      card.innerHTML = `
        <div class="step-number">${index + 1}</div>
        <div class="step-text">${step}</div>
      `;
      
      list.appendChild(card);
    });
  },

  toggleCookingMode() {
    const active = document.getElementById('toggle-cooking-mode').checked;
    state.cookingModeActive = active;
    
    const stepsList = document.getElementById('detail-steps-list');
    if (active) {
      stepsList.classList.add('cooking-mode-active');
      state.activeStepIndex = 0;
      this.highlightActiveStep();
    } else {
      stepsList.classList.remove('cooking-mode-active');
      // Clean classes
      document.querySelectorAll('.step-card').forEach(card => {
        card.classList.remove('active-step');
      });
    }
  },

  handleStepClick(index) {
    const card = document.getElementById(`step-card-${index}`);
    if (state.cookingModeActive) {
      state.activeStepIndex = index;
      this.highlightActiveStep();
      card.classList.toggle('completed');
    } else {
      card.classList.toggle('completed');
    }
  },

  highlightActiveStep() {
    document.querySelectorAll('.step-card').forEach((card, idx) => {
      if (idx === state.activeStepIndex) {
        card.classList.add('active-step');
        // Scroll step into view smoothly
        card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      } else {
        card.classList.remove('active-step');
      }
    });
  },

  // --- Recipe Form View (Add/Edit) ---
  openAddRecipeForm() {
    // Reset form fields
    document.getElementById('form-recipe-id').value = '';
    document.getElementById('form-view-title').textContent = 'Nouvelle Recette';
    document.getElementById('form-title').value = '';
    document.getElementById('form-description').value = '';
    document.getElementById('form-category').value = 'Plat';
    document.getElementById('form-servings').value = 4;
    document.getElementById('form-prep-time').value = 15;
    document.getElementById('form-cook-time').value = 30;
    document.getElementById('form-tags').value = '';
    
    document.getElementById('form-ingredients-list').innerHTML = '';
    document.getElementById('form-steps-list').innerHTML = '';
    
    // Enable AI Wizard
    document.getElementById('ai-wizard-container').classList.remove('hidden');
    
    // Clear preview image
    state.selectedImageBlob = null;
    const preview = document.getElementById('form-image-preview');
    preview.src = this.getRecipeSVGPlaceholder();
    
    // Add first rows
    this.addFormIngredientRow();
    this.addFormStepRow();
    
    this.navigate('form');
  },

  openEditRecipeForm(recipeId) {
    const recipe = state.recipes.find(r => r.id === recipeId);
    if (!recipe) return;
    
    state.activeRecipe = recipe;
    
    // Fill fields
    document.getElementById('form-recipe-id').value = recipe.id;
    document.getElementById('form-view-title').textContent = 'Modifier la Recette';
    document.getElementById('form-title').value = recipe.title;
    document.getElementById('form-description').value = recipe.description || '';
    document.getElementById('form-category').value = recipe.category || 'Plat';
    document.getElementById('form-servings').value = recipe.servings || 4;
    document.getElementById('form-prep-time').value = recipe.prepTime || 15;
    document.getElementById('form-cook-time').value = recipe.cookTime || 30;
    document.getElementById('form-tags').value = (recipe.tags || []).join(', ');
    
    // Hide AI Wizard on edits
    document.getElementById('ai-wizard-container').classList.add('hidden');
    
    // Ingredients Rows
    const ingContainer = document.getElementById('form-ingredients-list');
    ingContainer.innerHTML = '';
    if (recipe.ingredients && recipe.ingredients.length > 0) {
      recipe.ingredients.forEach(ing => {
        this.addFormIngredientRow(ing);
      });
    } else {
      this.addFormIngredientRow();
    }
    
    // Steps Rows
    const stepContainer = document.getElementById('form-steps-list');
    stepContainer.innerHTML = '';
    if (recipe.steps && recipe.steps.length > 0) {
      recipe.steps.forEach(step => {
        this.addFormStepRow(step);
      });
    } else {
      this.addFormStepRow();
    }
    
    // Load Photo Preview
    state.selectedImageBlob = null;
    const preview = document.getElementById('form-image-preview');
    if (recipe.imageId) {
      preview.src = this.getRecipeSVGPlaceholder();
      this.displayDriveImage(recipe.imageId, 'form-image-preview');
    } else {
      preview.src = this.getRecipeSVGPlaceholder();
    }
    
    this.navigate('form');
  },

  addFormIngredientRow(data = null) {
    const container = document.getElementById('form-ingredients-list');
    const row = document.createElement('div');
    row.className = 'form-row-ingredient';
    
    let text = '';
    if (data) {
      const parts = [];
      if (data.quantity !== null && data.quantity !== undefined) parts.push(data.quantity);
      if (data.unit) {
        const isShortUnit = ['g', 'cl', 'ml', 'g.', 'cl.', 'ml.'].includes(data.unit.toLowerCase());
        if (isShortUnit && data.quantity !== null && data.quantity !== undefined) {
          parts[0] = parts[0] + data.unit;
        } else {
          parts.push(data.unit);
        }
      }
      if (data.name) parts.push(data.name);
      text = parts.join(' ');
    }
    
    row.innerHTML = `
      <input type="text" placeholder="Ex: 250g de farine" class="ingredient-input" value="${text}" required>
      <button type="button" class="btn-icon" onclick="this.parentElement.remove()" title="Supprimer">
        <i class="fa-solid fa-trash text-primary"></i>
      </button>
    `;
    container.appendChild(row);
  },

  addFormStepRow(text = '') {
    const container = document.getElementById('form-steps-list');
    const li = document.createElement('li');
    li.className = 'form-row-step';
    
    li.innerHTML = `
      <textarea rows="2" placeholder="Décrivez cette étape de préparation..." required>${text}</textarea>
      <button type="button" class="btn-icon" onclick="this.parentElement.remove()" title="Supprimer">
        <i class="fa-solid fa-trash text-primary"></i>
      </button>
    `;
    container.appendChild(li);
  },

  cancelForm() {
    const recipeId = document.getElementById('form-recipe-id').value;
    if (recipeId) {
      this.navigate('detail');
    } else {
      this.navigate('catalog');
    }
  },

  previewImage(event) {
    const file = event.target.files[0];
    if (!file) return;
    
    // Compress and show local preview
    this.showLoader('Optimisation de la photo...');
    this.compressAndResizeImage(file, (resizedBlob) => {
      state.selectedImageBlob = resizedBlob;
      const preview = document.getElementById('form-image-preview');
      preview.src = URL.createObjectURL(resizedBlob);
      this.hideLoader();
    });
  },

  // Compress and resize image using HTML5 Canvas
  compressAndResizeImage(file, callback) {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        let width = img.width;
        let height = img.height;
        
        // Max resolution constraint
        const MAX_SIZE = 1024;
        if (width > height) {
          if (width > MAX_SIZE) {
            height *= MAX_SIZE / width;
            width = MAX_SIZE;
          }
        } else {
          if (height > MAX_SIZE) {
            width *= MAX_SIZE / height;
            height = MAX_SIZE;
          }
        }
        
        canvas.width = width;
        canvas.height = height;
        
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);
        
        // Export to Blob (JPEG, compression quality 0.8)
        canvas.toBlob((blob) => {
          callback(blob);
        }, 'image/jpeg', 0.8);
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  },

  async saveRecipe() {
    const formTitle = document.getElementById('form-title').value.trim();
    if (!formTitle) {
      this.showToast('Veuillez donner un titre à la recette', 'error');
      return;
    }
    
    this.showLoader('Enregistrement de la recette...');
    
    const recipeId = document.getElementById('form-recipe-id').value;
    const isEdit = !!recipeId;
    
    // Collect ingredients
    const ingredients = [];
    document.querySelectorAll('#form-ingredients-list .form-row-ingredient').forEach(row => {
      const textVal = row.querySelector('.ingredient-input').value.trim();
      if (textVal) {
        const parsed = this.parseIngredientText(textVal);
        ingredients.push(parsed);
      }
    });

    // Collect steps
    const steps = [];
    document.querySelectorAll('#form-steps-list .form-row-step textarea').forEach(txt => {
      const stepText = txt.value.trim();
      if (stepText) {
        steps.push(stepText);
      }
    });

    // Build or update recipe object
    let recipe;
    if (isEdit) {
      recipe = state.recipes.find(r => r.id === recipeId);
    } else {
      recipe = {
        id: 'recipe_' + Date.now(),
        createdAt: new Date().toISOString()
      };
    }
    
    recipe.title = formTitle;
    recipe.description = document.getElementById('form-description').value.trim();
    recipe.category = document.getElementById('form-category').value;
    recipe.servings = parseInt(document.getElementById('form-servings').value) || 4;
    recipe.prepTime = parseInt(document.getElementById('form-prep-time').value) || 0;
    recipe.cookTime = parseInt(document.getElementById('form-cook-time').value) || 0;
    recipe.tags = document.getElementById('form-tags').value.split(',').map(t => t.trim()).filter(t => t);
    recipe.ingredients = ingredients;
    recipe.steps = steps;
    recipe.updatedAt = new Date().toISOString();

    try {
      // 1. Upload photo to Google Drive first if selected
      if (state.selectedImageBlob) {
        const imgName = `${recipe.id}.jpg`;
        const imageId = await this.uploadImageToDrive(state.selectedImageBlob, imgName);
        recipe.imageId = imageId;
      }
      
      // 2. Insert or update in local list
      if (!isEdit) {
        state.recipes.push(recipe);
      }
      
      // 3. Save local cache
      this.saveRecipesLocally();
      
      // 4. Synchronize back to Google Drive
      if (this.isUserConnected()) {
        await this.uploadRecipesFile(state.config.folderId);
        this.showToast('Recette enregistrée et synchronisée !', 'success');
      } else {
        this.showToast('Enregistré localement (hors-ligne)', 'info');
      }
      
      this.renderCatalog();
      this.openRecipeDetail(recipe.id);
      this.hideLoader();
    } catch (err) {
      console.error(err);
      this.showToast(`Erreur lors de la sauvegarde : ${err.message}`, 'error');
      this.hideLoader();
    }
  },

  async deleteRecipe(recipeId) {
    if (!confirm('Voulez-vous vraiment supprimer cette recette ?')) return;
    
    this.showLoader('Suppression de la recette...');
    
    try {
      // Find index
      const index = state.recipes.findIndex(r => r.id === recipeId);
      if (index > -1) {
        state.recipes.splice(index, 1);
        this.saveRecipesLocally();
        
        if (this.isUserConnected()) {
          await this.uploadRecipesFile(state.config.folderId);
          this.showToast('Recette supprimée de Google Drive', 'success');
        } else {
          this.showToast('Supprimée localement (hors-ligne)', 'info');
        }
        
        this.navigate('catalog');
        this.renderCatalog();
      }
    } catch (err) {
      console.error(err);
      this.showToast(`Erreur lors de la suppression : ${err.message}`, 'error');
    } finally {
      this.hideLoader();
    }
  },

  // --- AI Imports (Gemini) ---
  switchWizardTab(tabId) {
    document.querySelectorAll('.wizard-tab-btn').forEach(btn => btn.classList.remove('active'));
    document.querySelectorAll('.wizard-panel').forEach(panel => panel.classList.remove('active'));
    
    document.getElementById(`wizard-tab-${tabId}`).classList.add('active');
    document.getElementById(`wizard-panel-${tabId}`).classList.add('active');
  },

  showAiLoading(text) {
    const loading = document.getElementById('ai-loading');
    loading.classList.remove('hidden');
    document.getElementById('ai-loading-text').textContent = text;
  },

  hideAiLoading() {
    document.getElementById('ai-loading').classList.add('hidden');
  },

  async callGeminiApi(payload) {
    if (!state.config.geminiApiKey) {
      throw new Error('Clé API Gemini manquante. Configurez-la dans les paramètres.');
    }
    
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${state.config.geminiApiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    
    if (!response.ok) {
      const errText = await response.json().catch(() => ({}));
      const errMsg = errText.error ? errText.error.message : 'Inconnue';
      throw new Error(`API Gemini (${response.status}) : ${errMsg}`);
    }
    
    const data = await response.json();
    if (!data.candidates || data.candidates.length === 0) {
      throw new Error('Gemini n\'a renvoyé aucun résultat.');
    }
    
    const rawText = data.candidates[0].content.parts[0].text;
    return this.cleanGeminiJson(rawText);
  },

  cleanGeminiJson(text) {
    let clean = text.trim();
    if (clean.includes('```')) {
      // Match anything between ```json and ```
      const match = clean.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
      if (match && match[1]) {
        clean = match[1];
      }
    }
    return JSON.parse(clean.trim());
  },

  async importRecipeFromPhoto(event) {
    const file = event.target.files[0];
    if (!file) return;
    
    this.showAiLoading('Conversion de la photo...');
    
    // Compress photo for Gemini to save bandwidth
    this.compressAndResizeImage(file, async (compressedBlob) => {
      // Convert to Base64
      const reader = new FileReader();
      reader.onload = async () => {
        const base64Data = reader.result.split(',')[1];
        
        this.showAiLoading('Analyse de l\'image par Gemini...');
        try {
          const prompt = `Tu es un assistant de cuisine expert. Analyse cette photo de recette (qui peut être un livre de cuisine, une note manuscrite, ou autre) et extrait ses informations sous forme de JSON correspondant à ce schéma précis en respectant scrupuleusement la langue d'origine ou en traduisant en français :
          {
            "title": "Titre court",
            "description": "Explication courte",
            "prepTime": 15,
            "cookTime": 30,
            "servings": 4,
            "category": "Entrée|Plat|Dessert|Apéritif|Boisson|Autre",
            "tags": ["tag1", "tag2"],
            "ingredients": [{"name": "Nom ingrédient", "quantity": 1.5, "unit": "g|kg|l|cl|ml|cuillère à soupe|sachet|unité|pincée"}],
            "steps": ["Étape 1...", "Étape 2..."]
          }
          Réponds uniquement avec le JSON.`;

          const payload = {
            contents: [
              {
                parts: [
                  { text: prompt },
                  { inlineData: { mimeType: 'image/jpeg', data: base64Data } }
                ]
              }
            ]
          };

          const parsedRecipe = await this.callGeminiApi(payload);
          this.applyImportedRecipe(parsedRecipe);
          
          // Also set the imported picture as the recipe cover photo
          state.selectedImageBlob = compressedBlob;
          document.getElementById('form-image-preview').src = URL.createObjectURL(compressedBlob);
          
          this.showToast('Recette extraite avec succès !', 'success');
        } catch (err) {
          console.error(err);
          this.showToast(`Échec de l'extraction IA : ${err.message}`, 'error');
        } finally {
          this.hideAiLoading();
          // Reset file input value
          document.getElementById('wizard-photo-file').value = '';
        }
      };
      reader.readAsDataURL(compressedBlob);
    });
  },

  async fetchHtmlWithFallback(url) {
    const proxies = [
      {
        url: (u) => `https://corsproxy.io/?${u}`,
        parse: async (res) => await res.text()
      },
      {
        url: (u) => `https://api.allorigins.win/get?url=${encodeURIComponent(u)}`,
        parse: async (res) => {
          const data = await res.json();
          return data.contents;
        }
      },
      {
        url: (u) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(u)}`,
        parse: async (res) => await res.text()
      }
    ];

    let lastError = null;
    for (const proxy of proxies) {
      try {
        const proxyUrl = proxy.url(url);
        const response = await fetch(proxyUrl);
        if (!response.ok) throw new Error(`Status ${response.status}`);
        const html = await proxy.parse(response);
        if (html && html.trim().length > 0) {
          return html;
        }
      } catch (err) {
        console.warn(`Proxy failed: ${proxy.url(url)}`, err);
        lastError = err;
      }
    }
    throw new Error(lastError ? lastError.message : 'Tous les proxies CORS ont échoué.');
  },

  async fetchBlobWithFallback(url) {
    const proxyUrls = [
      `https://corsproxy.io/?${url}`,
      `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
      `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`
    ];
    
    for (const proxyUrl of proxyUrls) {
      try {
        const response = await fetch(proxyUrl);
        if (response.ok) {
          return await response.blob();
        }
      } catch (err) {
        console.warn(`Failed to fetch image via proxy: ${proxyUrl}`, err);
      }
    }
    throw new Error('Impossible de télécharger l\'image via les proxies.');
  },

  async importRecipeFromUrl() {
    const url = document.getElementById('wizard-url-input').value.trim();
    if (!url) {
      this.showToast('Veuillez saisir un lien URL valide', 'error');
      return;
    }
    
    this.showAiLoading('Scraping du site web...');
    
    try {
      // 1. Fetch web page HTML using CORS Proxies with Fallback
      const rawHtml = await this.fetchHtmlWithFallback(url);
      
      // Try parsing with JSON-LD Schema first (Mealie parser style)
      this.showAiLoading('Recherche de métadonnées structurées...');
      let parsedRecipe = this.parseRecipeSchema(rawHtml);
      
      if (parsedRecipe) {
        this.applyImportedRecipe(parsedRecipe);
        
        // Try to fetch cover image if present
        if (parsedRecipe.imageUrl) {
          this.showAiLoading('Téléchargement de la photo de la recette...');
          try {
            const imgBlob = await this.fetchBlobWithFallback(parsedRecipe.imageUrl);
            this.compressAndResizeImage(imgBlob, (resizedBlob) => {
              state.selectedImageBlob = resizedBlob;
              document.getElementById('form-image-preview').src = URL.createObjectURL(resizedBlob);
            });
          } catch (imgErr) {
            console.warn('Failed to fetch recipe image', imgErr);
          }
        }
        
        this.showToast('Recette importée via Métadonnées (sans IA) !', 'success');
        document.getElementById('wizard-url-input').value = '';
      } else {
        // Fallback to Gemini AI
        if (!state.config.geminiApiKey) {
          throw new Error('Aucune métadonnée structurée trouvée sur ce site. Veuillez configurer une clé d\'API Gemini dans les paramètres pour activer l\'analyse par IA.');
        }
        
        this.showAiLoading('Analyse de la page par Gemini...');
        const cleanedText = this.cleanHtmlForAi(rawHtml);
        
        const prompt = `Tu es un assistant de cuisine expert. Analyse le texte brut suivant extrait d'un site internet de cuisine, et structure la recette sous forme de JSON correspondant à ce schéma précis :
        {
          "title": "Titre court",
          "description": "Explication courte",
          "prepTime": 15,
          "cookTime": 30,
          "servings": 4,
          "category": "Entrée|Plat|Dessert|Apéritif|Boisson|Autre",
          "tags": ["tag1", "tag2"],
          "ingredients": [{"name": "Nom ingrédient", "quantity": 1.5, "unit": "g|kg|l|cl|ml|cuillère à soupe|sachet|unité|pincée"}],
          "steps": ["Étape 1...", "Étape 2..."]
        }
        Réponds uniquement avec le JSON. Voici le texte brut : \n\n${cleanedText}`;

        const payload = {
          contents: [
            {
              parts: [{ text: prompt }]
            }
          ]
        };

        const parsedRecipe = await this.callGeminiApi(payload);
        this.applyImportedRecipe(parsedRecipe);
        
        this.showToast('Recette importée via IA Gemini !', 'success');
        document.getElementById('wizard-url-input').value = '';
      }
    } catch (err) {
      console.error(err);
      this.showToast(`Échec de l'import : ${err.message}`, 'error');
    } finally {
      this.hideAiLoading();
    }
  },

  async importRecipeFromPaste() {
    const rawText = document.getElementById('wizard-paste-input').value.trim();
    if (!rawText) {
      this.showToast('Veuillez coller du texte ou du code source HTML', 'error');
      return;
    }
    
    this.showAiLoading('Analyse du texte collé...');
    
    try {
      const isHtml = /<[a-z][\s\S]*>/i.test(rawText);
      
      if (isHtml) {
        this.showAiLoading('Recherche de métadonnées structurées dans l\'HTML...');
        const parsedRecipe = this.parseRecipeSchema(rawText);
        if (parsedRecipe) {
          this.applyImportedRecipe(parsedRecipe);
          
          if (parsedRecipe.imageUrl) {
            this.showAiLoading('Téléchargement de la photo de la recette...');
            try {
              const imgBlob = await this.fetchBlobWithFallback(parsedRecipe.imageUrl);
              this.compressAndResizeImage(imgBlob, (resizedBlob) => {
                state.selectedImageBlob = resizedBlob;
                document.getElementById('form-image-preview').src = URL.createObjectURL(resizedBlob);
              });
            } catch (imgErr) {
              console.warn('Failed to fetch recipe image', imgErr);
            }
          }
          
          this.showToast('Recette importée à partir de l\'HTML (sans IA) !', 'success');
          document.getElementById('wizard-paste-input').value = '';
          this.hideAiLoading();
          return;
        }
      }
      
      // Fallback to Gemini AI
      if (!state.config.geminiApiKey) {
        throw new Error('Aucune métadonnée structurée trouvée dans le code collé. Veuillez configurer une clé d\'API Gemini dans les paramètres pour pouvoir analyser du texte brut.');
      }
      
      this.showAiLoading('Analyse du texte brut par Gemini...');
      const textToAnalyze = isHtml ? this.cleanHtmlForAi(rawText) : rawText;
      
      const prompt = `Tu es un assistant de cuisine expert. Analyse le texte brut suivant et structure la recette sous forme de JSON correspondant à ce schéma précis :
      {
        "title": "Titre court",
        "description": "Explication courte",
        "prepTime": 15,
        "cookTime": 30,
        "servings": 4,
        "category": "Entrée|Plat|Dessert|Apéritif|Boisson|Autre",
        "tags": ["tag1", "tag2"],
        "ingredients": [{"name": "Nom ingrédient", "quantity": 1.5, "unit": "g|kg|l|cl|ml|cuillère à soupe|sachet|unité|pincée"}],
        "steps": ["Étape 1...", "Étape 2..."]
      }
      Réponds uniquement avec le JSON. Voici le texte : \n\n${textToAnalyze}`;

      const payload = {
        contents: [
          {
            parts: [{ text: prompt }]
          }
        ]
      };

      const parsedRecipe = await this.callGeminiApi(payload);
      this.applyImportedRecipe(parsedRecipe);
      
      this.showToast('Recette importée via IA Gemini !', 'success');
      document.getElementById('wizard-paste-input').value = '';
    } catch (err) {
      console.error(err);
      this.showToast(`Échec de l'analyse : ${err.message}`, 'error');
    } finally {
      this.hideAiLoading();
    }
  },

  cleanHtmlForAi(html) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    
    // Remove scripts, styles, forms, navigation structures
    const tagsToRemove = ['script', 'style', 'noscript', 'iframe', 'header', 'footer', 'nav', 'form', 'aside', 'svg'];
    tagsToRemove.forEach(tag => {
      doc.querySelectorAll(tag).forEach(el => el.remove());
    });
    
    // Extract text content of structural areas (or full body)
    let bodyText = doc.body.innerText || '';
    
    // Strip empty lines and multiple spaces
    bodyText = bodyText.replace(/\s+/g, ' ');
    
    // Cap text to avoid Gemini tokens overflow (max 20000 characters is plenty for a recipe site)
    if (bodyText.length > 20000) {
      bodyText = bodyText.substring(0, 20000);
    }
    
    return bodyText;
  },

  parseRecipeSchema(html) {
    try {
      const parser = new DOMParser();
      const doc = parser.parseFromString(html, 'text/html');
      const jsonLdScripts = doc.querySelectorAll('script[type="application/ld+json"]');
      
      let recipeSchema = null;
      
      for (const script of jsonLdScripts) {
        try {
          const data = JSON.parse(script.textContent);
          
          const searchForRecipe = (obj) => {
            if (!obj) return null;
            if (obj['@type'] === 'Recipe' || (Array.isArray(obj['@type']) && obj['@type'].includes('Recipe'))) return obj;
            if (Array.isArray(obj)) {
              for (const item of obj) {
                const r = searchForRecipe(item);
                if (r) return r;
              }
            }
            if (obj['@graph'] && Array.isArray(obj['@graph'])) {
              for (const item of obj['@graph']) {
                const r = searchForRecipe(item);
                if (r) return r;
              }
            }
            return null;
          };
          
          recipeSchema = searchForRecipe(data);
          if (recipeSchema) break;
        } catch (e) {
          console.warn('Error parsing JSON-LD script', e);
        }
      }
      
      if (!recipeSchema) return null;
      
      // Extract and clean fields
      const title = recipeSchema.name || '';
      const description = recipeSchema.description || '';
      
      const parseISO8601Duration = (durationStr) => {
        if (!durationStr) return 0;
        const match = durationStr.match(/PT(?:(\d+)H)?(?:(\d+)M)?/);
        if (!match) return 0;
        const hours = parseInt(match[1] || 0);
        const minutes = parseInt(match[2] || 0);
        return hours * 60 + minutes;
      };
      
      const prepTime = parseISO8601Duration(recipeSchema.prepTime);
      const cookTime = parseISO8601Duration(recipeSchema.cookTime);
      
      let servings = 4;
      if (recipeSchema.recipeYield) {
        const yieldStr = String(recipeSchema.recipeYield);
        const numMatch = yieldStr.match(/\d+/);
        if (numMatch) servings = parseInt(numMatch[0]);
      }
      
      let category = 'Plat';
      if (recipeSchema.recipeCategory) {
        const catStr = Array.isArray(recipeSchema.recipeCategory) 
          ? recipeSchema.recipeCategory[0] 
          : recipeSchema.recipeCategory;
        if (catStr.toLowerCase().includes('entr')) category = 'Entrée';
        else if (catStr.toLowerCase().includes('dessert')) category = 'Dessert';
        else if (catStr.toLowerCase().includes('boiss')) category = 'Boisson';
        else if (catStr.toLowerCase().includes('apér')) category = 'Apéritif';
        else category = 'Plat';
      }
        
      const tags = [];
      if (recipeSchema.keywords) {
        const kw = recipeSchema.keywords;
        if (typeof kw === 'string') {
          tags.push(...kw.split(',').map(s => s.trim()));
        } else if (Array.isArray(kw)) {
          tags.push(...kw.map(s => String(s).trim()));
        }
      }
      
      const rawIngredients = recipeSchema.recipeIngredient || [];
      const ingredients = rawIngredients.map(ingText => this.parseIngredientText(ingText));
      
      let steps = [];
      if (recipeSchema.recipeInstructions) {
        const inst = recipeSchema.recipeInstructions;
        if (Array.isArray(inst)) {
          steps = inst.map(stepObj => {
            if (typeof stepObj === 'string') return stepObj;
            if (stepObj.text) return stepObj.text;
            if (stepObj.itemListElement && Array.isArray(stepObj.itemListElement)) {
              return stepObj.itemListElement.map(el => el.text || '').filter(t => t);
            }
            return '';
          }).flat().filter(t => t);
        } else if (typeof inst === 'string') {
          steps = inst.split('\n').map(s => s.trim()).filter(s => s);
        }
      }
      
      let imageUrl = '';
      if (recipeSchema.image) {
        if (typeof recipeSchema.image === 'string') {
          imageUrl = recipeSchema.image;
        } else if (Array.isArray(recipeSchema.image)) {
          imageUrl = recipeSchema.image[0];
        } else if (recipeSchema.image.url) {
          imageUrl = recipeSchema.image.url;
        }
      }
      
      return {
        title,
        description,
        prepTime,
        cookTime,
        servings,
        category,
        tags,
        ingredients,
        steps,
        imageUrl
      };
    } catch (err) {
      console.warn('Failed to extract schema metadata', err);
      return null;
    }
  },

  parseIngredientText(text) {
    text = text.trim();
    let quantity = null;
    let unit = '';
    let name = '';
    
    // 1. Try to match standard fraction or decimal at the start
    // Matches "1", "1.5", "1/2", "3/4"
    const numRegex = /^(\d+[\/\.]\d+|\d+)\s*/;
    const match = text.match(numRegex);
    if (match) {
      let qtyStr = match[1];
      if (qtyStr.includes('/')) {
        const parts = qtyStr.split('/');
        quantity = parseFloat(parts[0]) / parseFloat(parts[1]);
      } else {
        quantity = parseFloat(qtyStr);
      }
      text = text.substring(match[0].length).trim();
    }
    
    // 2. Check for common units
    const units = [
      'g', 'kg', 'ml', 'cl', 'l', 'dl', 'g.', 'kg.', 'ml.', 'cl.', 'l.',
      'cuillère à soupe', 'cuillères à soupe', 'c. à soupe', 'c. à s.', 'c.a.s.', 'cas',
      'cuillère à café', 'cuillères à café', 'c. à café', 'c. à c.', 'c.a.c.', 'cac',
      'sachet', 'sachets', 'pincée', 'pincées', 'gousse', 'gousses', 'tranche', 'tranches',
      'tasse', 'tasses', 'verre', 'verres', 'pot', 'pots', 'boite', 'boites', 'boîte', 'boîtes',
      'feuille', 'feuilles', 'brin', 'brins', 'filet', 'filets', 'morceau', 'morceaux',
      'brique', 'briques', 'goutte', 'gouttes'
    ];
    
    units.sort((a, b) => b.length - a.length);
    
    let foundUnit = false;
    for (const u of units) {
      const unitRegex = new RegExp(`^(${u})\\b\\s*(?:de\\s+|d'\\s*)?`, 'i');
      const unitMatch = text.match(unitRegex);
      if (unitMatch) {
        unit = unitMatch[1];
        text = text.substring(unitMatch[0].length).trim();
        foundUnit = true;
        break;
      }
    }
    
    if (!foundUnit) {
      const deMatch = text.match(/^(?:de\s+|d'\s*)/i);
      if (deMatch) {
        text = text.substring(deMatch[0].length).trim();
      }
    }
    
    name = text;
    
    return {
      quantity: quantity,
      unit: unit,
      name: name
    };
  },

  applyImportedRecipe(recipe) {
    // Fill basic fields
    document.getElementById('form-title').value = recipe.title || '';
    document.getElementById('form-description').value = recipe.description || '';
    document.getElementById('form-category').value = recipe.category || 'Plat';
    document.getElementById('form-servings').value = recipe.servings || 4;
    document.getElementById('form-prep-time').value = recipe.prepTime || 15;
    document.getElementById('form-cook-time').value = recipe.cookTime || 30;
    document.getElementById('form-tags').value = (recipe.tags || []).join(', ');
    
    // Load ingredients
    const ingContainer = document.getElementById('form-ingredients-list');
    ingContainer.innerHTML = '';
    if (recipe.ingredients && recipe.ingredients.length > 0) {
      recipe.ingredients.forEach(ing => {
        this.addFormIngredientRow(ing);
      });
    } else {
      this.addFormIngredientRow();
    }
    
    // Load steps
    const stepContainer = document.getElementById('form-steps-list');
    stepContainer.innerHTML = '';
    if (recipe.steps && recipe.steps.length > 0) {
      recipe.steps.forEach(step => {
        this.addFormStepRow(step);
      });
    } else {
      this.addFormStepRow();
    }
    
    // Scroll past wizard to show fields filled
    document.getElementById('recipe-form').scrollIntoView({ behavior: 'smooth' });
  },

  // --- UI Helpers ---
  showToast(message, type = 'info') {
    const toast = document.getElementById('toast');
    toast.className = `toast show`;
    
    // Style by type
    if (type === 'success') {
      toast.innerHTML = `<i class="fa-solid fa-circle-check text-primary"></i> &nbsp;${message}`;
    } else if (type === 'error') {
      toast.innerHTML = `<i class="fa-solid fa-circle-xmark text-primary"></i> &nbsp;${message}`;
    } else if (type === 'warning') {
      toast.innerHTML = `<i class="fa-solid fa-triangle-exclamation text-primary"></i> &nbsp;${message}`;
    } else {
      toast.innerHTML = `<i class="fa-solid fa-info text-primary"></i> &nbsp;${message}`;
    }
    
    setTimeout(() => {
      toast.classList.remove('show');
    }, 3500);
  },

  showLoader(text = 'Chargement...') {
    const loader = document.getElementById('app-loader');
    document.getElementById('loader-text').textContent = text;
    loader.classList.add('active');
  },

  hideLoader() {
    const loader = document.getElementById('app-loader');
    loader.classList.remove('active');
  },

  togglePasswordVisibility(id) {
    const input = document.getElementById(id);
    const icon = input.nextElementSibling.querySelector('i');
    
    if (input.type === 'password') {
      input.type = 'text';
      icon.className = 'fa-regular fa-eye-slash';
    } else {
      input.type = 'password';
      icon.className = 'fa-regular fa-eye';
    }
  },

  // Inline SVG generator for recipes with no cover photo
  getRecipeSVGPlaceholder() {
    return 'data:image/svg+xml;utf8,' + encodeURIComponent(`
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300" width="100%" height="100%">
        <rect width="100%" height="100%" fill="%23292524"/>
        <g fill="none" stroke="%23ea580c" stroke-width="6" stroke-linecap="round" stroke-linejoin="round" transform="translate(140, 90)">
          <!-- Chef Hat/Cook icon -->
          <path d="M 60 50 A 35 35 0 0 1 10 50 A 25 25 0 0 1 30 15 A 25 25 0 0 1 90 15 A 25 25 0 0 1 110 50 A 35 35 0 0 1 60 50 Z" />
          <path d="M 25 50 L 95 50 L 90 75 L 30 75 Z" />
          <path d="M 40 75 L 80 75 L 75 90 L 45 90 Z" />
        </g>
        <text x="50%" y="240" fill="%23a8a29e" font-family="'Outfit', sans-serif" font-size="16" font-weight="600" text-anchor="middle">Aucune photo</text>
      </svg>
    `);
  }
};
