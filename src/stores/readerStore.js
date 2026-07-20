import { create } from 'zustand';

function loadShowAllTranslations() {
  const val = localStorage.getItem('vocabapp:showAllTranslations');
  return val || 'off';
}

export const useReaderStore = create((set) => ({
  // UI panels
  sidebarOpen: false,
  searchOpen: false,
  bookmarkMenuOpen: false,
  settingsMenuOpen: false,
  distractionFree: false,
  batchModalOpen: false,

  // Search
  searchQuery: '',
  searchMatches: [],
  activeSearchIdx: 0,

  // Display
  showAllTranslations: loadShowAllTranslations(),
  keyHintVisible: !localStorage.getItem('vocabapp:keyHintDismissed'),
  pageFlash: null,
  isFullscreen: false,

  // Actions
  toggleSidebar: () => set((s) => {
    const next = !s.sidebarOpen;
    return { sidebarOpen: next, searchOpen: false, bookmarkMenuOpen: false, settingsMenuOpen: false };
  }),
  toggleSearch: () => set((s) => {
    const next = !s.searchOpen;
    return { searchOpen: next, bookmarkMenuOpen: false, settingsMenuOpen: false, sidebarOpen: false };
  }),
  toggleBookmarkMenu: () => set((s) => {
    const next = !s.bookmarkMenuOpen;
    return { bookmarkMenuOpen: next, searchOpen: false, settingsMenuOpen: false };
  }),
  toggleSettingsMenu: () => set((s) => {
    const next = !s.settingsMenuOpen;
    return { settingsMenuOpen: next, searchOpen: false, bookmarkMenuOpen: false };
  }),
  toggleDistractionFree: () => set((s) => ({ distractionFree: !s.distractionFree })),
  toggleFullscreen: () => set((s) => ({ isFullscreen: !s.isFullscreen })),

  setSearchQuery: (q) => set({ searchQuery: q }),
  setSearchResults: (matches, idx) => set({ searchMatches: matches, activeSearchIdx: idx }),
  setActiveSearchIdx: (idx) => set({ activeSearchIdx: idx }),

  setShowAllTranslations: (mode) => {
    localStorage.setItem('vocabapp:showAllTranslations', mode);
    set({ showAllTranslations: mode });
  },

  dismissKeyHint: () => {
    localStorage.setItem('vocabapp:keyHintDismissed', '1');
    set({ keyHintVisible: false });
  },

  setPageFlash: (dir) => set({ pageFlash: dir }),
  clearPageFlash: () => set({ pageFlash: null }),

  setBatchModalOpen: (open) => set({ batchModalOpen: open }),

  closeAllPanels: () => set({
    searchOpen: false,
    bookmarkMenuOpen: false,
    settingsMenuOpen: false,
    sidebarOpen: false,
  }),
}));
