/**
 * Firebase Auth Module + MySQL Sync
 * Handles Google Sign-In via Firebase, then registers user in local MySQL
 * Returns JWT token for authenticated API calls
 */

const Auth = {
    user: null,
    db: null,
    _initialized: false,
    _serverToken: null, // JWT token from server-api/auth.php

    /**
     * Initialize Firebase and Auth
     */
    async init() {
        if (this._initialized) return;

        try {
            // Initialize Firebase
            const app = firebase.initializeApp({
                apiKey: "AIzaSyA9Jp03wbPkjkcdOfpLhF1sMb_lmUMTsbQ",
                authDomain: "musicweb-e1397.firebaseapp.com",
                projectId: "musicweb-e1397",
                storageBucket: "musicweb-e1397.firebasestorage.app",
                messagingSenderId: "614424625069",
                appId: "1:614424625069:web:881fcd717509fb2a826b24"
            });

            this.db = firebase.firestore();
            this._initialized = true;

            // Load cached server token
            this._serverToken = localStorage.getItem('serverToken') || null;

            // Listen for auth state changes
            firebase.auth().onAuthStateChanged(async (user) => {
                this.user = user;
                this.updateUI();

                if (user) {
                    console.log(`Logged in as: ${user.displayName} (${user.email})`);

                    // Register/login to MySQL backend
                    await this._registerToServer();

                    // Sync playlists and liked songs from server (MySQL primary)
                    PlaylistManager.syncFromCloud();
                    LikedSongs.syncFromCloud();
                } else {
                    console.log('Not logged in');
                    this._serverToken = null;
                    localStorage.removeItem('serverToken');
                    // Load local playlists only
                    PlaylistManager.loadPlaylists();
                    PlaylistManager.renderPlaylistList();
                }
            });
        } catch (e) {
            console.error('Firebase init error:', e);
        }
    },

    /**
     * Register/login user to MySQL server via Firebase ID token
     */
    async _registerToServer() {
        try {
            const idToken = await this.user.getIdToken(true);
            const res = await fetch('server-api/auth.php', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ idToken })
            });

            if (res.ok) {
                const data = await res.json();
                this._serverToken = data.token;
                localStorage.setItem('serverToken', data.token);
                console.log('Server auth OK — MySQL user synced');
            } else {
                console.warn('Server auth failed, using local-only mode');
            }
        } catch (e) {
            console.warn('Server auth unavailable:', e.message);
        }
    },

    /**
     * Get server JWT token for API calls
     */
    getServerToken() {
        return this._serverToken;
    },

    /**
     * Get auth headers for server API calls
     */
    getAuthHeaders() {
        const headers = { 'Content-Type': 'application/json' };
        if (this._serverToken) {
            headers['Authorization'] = `Bearer ${this._serverToken}`;
        }
        return headers;
    },

    /**
     * Check if server sync is available
     */
    hasServerAuth() {
        return this._serverToken !== null;
    },

    /**
     * Login with Google popup
     */
    async loginWithGoogle() {
        try {
            const provider = new firebase.auth.GoogleAuthProvider();
            await firebase.auth().signInWithPopup(provider);
            UI.showToast(`Welcome, ${this.user.displayName}!`, 'success');
        } catch (e) {
            if (e.code !== 'auth/popup-closed-by-user') {
                console.error('Login error:', e);
                UI.showToast('Login failed. Please try again.', 'error');
            }
        }
    },

    /**
     * Logout
     */
    async logout() {
        try {
            await firebase.auth().signOut();
            this._serverToken = null;
            localStorage.removeItem('serverToken');
            UI.showToast('Logged out', 'info');
        } catch (e) {
            console.error('Logout error:', e);
        }
    },

    /**
     * Check if user is logged in
     */
    isLoggedIn() {
        return this.user !== null;
    },

    /**
     * Get current user UID
     */
    getUid() {
        return this.user?.uid || null;
    },

    /**
     * Update sidebar UI based on auth state
     */
    updateUI() {
        const authArea = document.getElementById('authArea');
        if (!authArea) return;

        if (this.user) {
            const photoURL = this.user.photoURL || '';
            const displayName = this.user.displayName || this.user.email || 'User';
            const initial = displayName.charAt(0).toUpperCase();

            authArea.innerHTML = `
                <div class="flex items-center gap-3 px-4 py-3">
                    ${photoURL 
                        ? `<img src="${photoURL}" alt="" class="w-9 h-9 rounded-full object-cover shrink-0">` 
                        : `<div class="w-9 h-9 rounded-full bg-primary flex items-center justify-center text-sm font-bold shrink-0">${initial}</div>`
                    }
                    <div class="min-w-0 flex-1">
                        <p class="text-sm font-medium text-white truncate">${displayName}</p>
                        <button onclick="Auth.logout()" class="text-xs text-gray-400 hover:text-red-400 transition-colors">Sign Out</button>
                    </div>
                </div>
            `;
        } else {
            authArea.innerHTML = `
                <button 
                    onclick="Auth.loginWithGoogle()"
                    class="w-full flex items-center gap-3 px-4 py-3 rounded-lg hover:bg-dark-100 transition-colors text-sm"
                >
                    <svg class="w-5 h-5 shrink-0" viewBox="0 0 24 24">
                        <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"/>
                        <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                        <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
                        <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
                    </svg>
                    <span class="text-gray-300">Login dengan Google</span>
                </button>
            `;
        }

        // Update settings view account section
        this.updateSettingsUI();
    },

    /**
     * Update account section in settings
     */
    updateSettingsUI() {
        const accountSection = document.getElementById('accountSection');
        if (!accountSection) return;

        if (this.user) {
            const photoURL = this.user.photoURL || '';
            const displayName = this.user.displayName || 'User';
            const email = this.user.email || '';
            const syncStatus = this.hasServerAuth()
                ? '<p class="text-xs text-green-400 mt-1">● Data tersinkron ke server</p>'
                : '<p class="text-xs text-yellow-400 mt-1">● Mode lokal (server tidak tersedia)</p>';

            accountSection.innerHTML = `
                <div class="flex items-center gap-4">
                    ${photoURL 
                        ? `<img src="${photoURL}" alt="" class="w-14 h-14 rounded-full object-cover">` 
                        : `<div class="w-14 h-14 rounded-full bg-primary flex items-center justify-center text-xl font-bold">${displayName.charAt(0)}</div>`
                    }
                    <div>
                        <p class="font-semibold text-white">${displayName}</p>
                        <p class="text-sm text-gray-400">${email}</p>
                        ${syncStatus}
                    </div>
                </div>
                <button 
                    onclick="Auth.logout()" 
                    class="mt-4 px-4 py-2 rounded-lg border border-red-500/30 text-red-400 hover:bg-red-500/10 text-sm transition-colors"
                >
                    Sign Out
                </button>
            `;
        } else {
            accountSection.innerHTML = `
                <p class="text-sm text-gray-400 mb-4">Login untuk menyimpan playlist ke server dan sinkron antar perangkat.</p>
                <button 
                    onclick="Auth.loginWithGoogle()" 
                    class="flex items-center gap-3 bg-white text-gray-800 px-5 py-3 rounded-lg font-medium hover:bg-gray-100 transition-colors"
                >
                    <svg class="w-5 h-5" viewBox="0 0 24 24">
                        <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"/>
                        <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                        <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
                        <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
                    </svg>
                    Login dengan Google
                </button>
            `;
        }
    }
};
