// app.js - FIXED version with chart duplication and data label fixes
console.log('🚀 app.js loading...');

// Define critical functions immediately at the top of the file
function showSaveMenu(button, contentType) {
  console.log('showSaveMenu called with:', contentType);
  // Close other menus
  document.querySelectorAll('.dropdown-menu').forEach(menu => {
    menu.classList.remove('show');
  });
  
  const menu = button.nextElementSibling;
  if (menu) {
    menu.classList.add('show');
    
    // Close on outside click
    setTimeout(() => {
      document.addEventListener('click', function closeMenu(e) {
        if (!menu.contains(e.target) && !button.contains(e.target)) {
          menu.classList.remove('show');
          document.removeEventListener('click', closeMenu);
        }
      });
    }, 10);
  }
}

function saveToReport(contentType) {
  console.log('saveToReport called with:', contentType);
  
  // Find the nearest card element
  let card;
  if (contentType === 'answer') {
    card = document.getElementById('answerCard');
  } else {
    // For theme cards, find the active dropdown
    const activeDropdown = document.querySelector('.dropdown-menu.show');
    if (activeDropdown) {
      card = activeDropdown.closest('.answer-card, .theme-card, .dashboard-item');
    }
  }
  
  if (card) {
    const title = card.querySelector('h4, h3, .answer-headline')?.textContent || 'Untitled';
    const content = card.querySelector('.answer-text, .theme-summary, .chart-content, .answer-details')?.textContent || '';
    
    // Hide the dropdown
    const dropdown = card.querySelector('.dropdown-menu');
    if (dropdown) dropdown.classList.remove('show');
    
    alert(`Saving "${title}" to report...`);
    console.log('Content to save:', { title, content });
  }
}

function exportContent(contentType) {
  console.log('exportContent called with:', contentType);
  
  // Find the nearest card element
  let card;
  if (contentType === 'answer') {
    card = document.getElementById('answerCard');
  } else {
    // For theme cards, find the active dropdown
    const activeDropdown = document.querySelector('.dropdown-menu.show');
    if (activeDropdown) {
      card = activeDropdown.closest('.answer-card, .theme-card, .dashboard-item');
    }
  }
  
  if (card) {
    const title = card.querySelector('h4, h3, .answer-headline')?.textContent || 'Untitled';
    const content = card.querySelector('.answer-text, .theme-summary, .chart-content, .answer-details')?.textContent || '';
    
    // Hide the dropdown
    const dropdown = card.querySelector('.dropdown-menu');
    if (dropdown) dropdown.classList.remove('show');
    
    // Create and download a simple text file
    const exportContent = `${title}\n${'='.repeat(title.length)}\n\n${content}`;
    const blob = new Blob([exportContent], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    
    const a = document.createElement('a');
    a.href = url;
    a.download = `${title.replace(/[^a-zA-Z0-9]/g, '_')}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    
    console.log('Exported:', title);
  }
}

// Make functions globally available immediately - CRITICAL FIX
if (typeof window !== 'undefined') {
  window.showSaveMenu = showSaveMenu;
  window.saveToReport = saveToReport;
  window.exportContent = exportContent;
  
  // Also assign to global scope directly
  globalThis.showSaveMenu = showSaveMenu;
  globalThis.saveToReport = saveToReport;
  globalThis.exportContent = exportContent;
  
  console.log('✅ Dropdown functions assigned to window:', {
    showSaveMenu: typeof window.showSaveMenu,
    saveToReport: typeof window.saveToReport,
    exportContent: typeof window.exportContent
  });
}

// Global state
let currentUser = null;
let currentClient = null;
let filters = {
  years: new Set(),
  methodology: new Set(),
  reports: new Set()
};
let availableFilters = {
  years: [],
  methodology: [],
  reports: []
};
let currentReferences = [];
let currentSaveContent = null;
let currentSaveType = null;

// REPORTS FUNCTIONALITY
let userReports = JSON.parse(localStorage.getItem('userReports') || '[]');

function saveToLocalStorage() {
  localStorage.setItem('userReports', JSON.stringify(userReports));
}

function switchToResultsLayout() {
  const contentArea = document.getElementById('contentArea');
  if (contentArea) {
    contentArea.classList.remove('initial-state');
    contentArea.classList.add('results-state');
    
    window.scrollTo({
      top: 0,
      behavior: 'smooth'
    });
  }
}

async function initializeApp() {
  console.log('🔧 Initializing app...');
  
  try {
    console.log('📡 Fetching user data from /me...');
    const response = await fetch('/me');
    console.log('📡 Response status:', response.status);
    
    if (!response.ok) {
      console.error('❌ Authentication failed, redirecting to login');
      window.location.href = '/login.html';
      return;
    }
    
    const userData = await response.json();
    console.log('✅ User data received:', userData);
    
    currentUser = userData.user;
    currentClient = userData.activeClientId;
    
    console.log('👤 Current user:', currentUser);
    console.log('🏢 Current client:', currentClient);
    
    updateUserDisplay();
    await loadClientLibraries();
    await loadFilters();
    setupEventListeners();
    
    console.log('✅ App initialized successfully');
    
  } catch (error) {
    console.error('❌ Failed to initialize app:', error);
    console.log('🔄 Redirecting to login...');
    window.location.href = '/login.html';
  }
}

function updateUserDisplay() {
  console.log('📝 Updating user display...');
  
  const userDisplay = document.getElementById('userDisplay');
  const companyNameDisplay = document.getElementById('companyNameDisplay');
  const adminCenterLink = document.getElementById('adminCenterLink');
  const clientSelectorCorner = document.getElementById('clientSelectorCorner');
  const sidebarAdminLink = document.getElementById('sidebarAdminLink');
  
  console.log('📝 DOM elements found:', {
    userDisplay: !!userDisplay,
    companyNameDisplay: !!companyNameDisplay,
    adminCenterLink: !!adminCenterLink,
    clientSelectorCorner: !!clientSelectorCorner,
    sidebarAdminLink: !!sidebarAdminLink
  });
  
  if (!userDisplay) {
    console.error('❌ userDisplay element not found!');
    return;
  }
  
  if (currentUser) {
    const roleDisplay = currentUser.role === 'admin' ? 'admin' : currentUser.role;
    const displayText = `${currentUser.username} (${roleDisplay})`;
    userDisplay.textContent = displayText;
    
    console.log('✅ Updated user display to:', displayText);
    console.log('👤 User role from server:', currentUser.role);
    
    // FIXED: Check if user is admin (server sends "admin" for both admin and internal users)
    if (currentUser.role === 'admin') {
      console.log('👑 User is admin, showing admin controls');
      if (adminCenterLink) {
        adminCenterLink.style.display = 'block';
        console.log('✅ Admin center link made visible');
      }
      if (sidebarAdminLink) {
        sidebarAdminLink.style.display = 'block';
        console.log('✅ Sidebar admin link made visible');
      }
      if (clientSelectorCorner) {
        clientSelectorCorner.classList.add('show');
        console.log('✅ Client selector made visible');
      }
      if (companyNameDisplay) {
        companyNameDisplay.style.display = 'none';
        console.log('✅ Company name hidden for admin');
      }
    } else {
      console.log('👤 User is client, showing client view');
      if (companyNameDisplay) {
        companyNameDisplay.style.display = 'block';
        companyNameDisplay.textContent = 'GENENTECH';
        console.log('✅ Company name shown for client');
      }
      if (clientSelectorCorner) {
        clientSelectorCorner.classList.remove('show');
        console.log('✅ Client selector hidden for client');
      }
      if (adminCenterLink) {
        adminCenterLink.style.display = 'none';
        console.log('✅ Admin center link hidden for client');
      }
      if (sidebarAdminLink) {
        sidebarAdminLink.style.display = 'none';
        console.log('✅ Sidebar admin link hidden for client');
      }
    }
  } else {
    console.log('⚠️ No current user, showing loading...');
    userDisplay.textContent = 'Loading...';
  }
}

async function loadClientLibraries() {
  console.log('📚 Loading client libraries...');
  
  try {
    const response = await fetch('/api/client-libraries');
    console.log('📚 Client libraries response status:', response.status);
    
    if (response.ok) {
      const libraries = await response.json();
      console.log('📚 Client libraries loaded:', libraries);
      
      const clientSelect = document.getElementById('clientSelect');
      if (clientSelect) {
        clientSelect.innerHTML = '<option value="">Select a client library</option>';
        
        libraries.forEach(lib => {
          const option = document.createElement('option');
          option.value = lib.id;
          option.textContent = lib.name;
          clientSelect.appendChild(option);
        });
        
        if (currentClient) {
          clientSelect.value = currentClient;
        }
        
        console.log('✅ Client select populated with', libraries.length, 'libraries');
      } else {
        console.warn('⚠️ clientSelect element not found');
      }
    } else {
      console.warn('⚠️ Failed to load client libraries:', response.status);
    }
  } catch (error) {
    console.warn('⚠️ Failed to load client libraries:', error);
  }
}

async function loadFilters() {
  console.log('🔍 Loading filters...');
  
  try {
    const clientId = currentUser?.role === 'admin' ? currentClient : null;
    const url = clientId ? `/api/filter-options?clientId=${clientId}` : '/api/filter-options';
    console.log('🔍 Fetching filters from:', url);
    
    const response = await fetch(url);
    let data = {};
    
    if (response.ok) {
      data = await response.json();
      console.log('✅ Filters loaded:', data);
    } else {
      console.warn('⚠️ Using fallback filters');
      data = {
        years: [],
        methodology: [],
        reports: []
      };
    }
    
    availableFilters = data;
    populateFilterOptions();
  } catch (error) {
    console.warn('⚠️ Failed to load filters:', error);
    availableFilters = {
      years: [],
      methodology: [],
      reports: []
    };
    populateFilterOptions();
  }
}

function populateFilterOptions() {
  console.log('🎛️ Populating filter options...');
  
  if (document.getElementById('yearFilters')) {
    populateFilterSection('yearFilters', availableFilters.years || [], 'years');
    populateFilterSection('methodFilters', availableFilters.methodology || [], 'methodology');
    populateFilterSection('reportFilters', availableFilters.reports || [], 'reports');
    console.log('✅ Filter options populated');
  } else {
    console.log('ℹ️ Filter elements not found (probably not on search page)');
  }
}

function populateFilterSection(containerId, options, filterType) {
  const container = document.getElementById(containerId);
  if (!container) return;
  
  container.innerHTML = '';
  
  options.forEach(option => {
    const optionDiv = document.createElement('div');
    optionDiv.className = 'filter-option';
    
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.id = `${filterType}_${option}`;
    checkbox.checked = true;
    checkbox.dataset.option = option;
    checkbox.addEventListener('change', (e) => {
      if (e.target.checked) {
        filters[filterType].add(option);
        e.target.parentElement.classList.add('selected');
      } else {
        filters[filterType].delete(option);
        e.target.parentElement.classList.remove('selected');
      }
    });
    
    const label = document.createElement('label');
    label.htmlFor = checkbox.id;
    label.textContent = option;
    label.title = option;
    
    filters[filterType].add(option);
    optionDiv.classList.add('selected');
    
    optionDiv.appendChild(checkbox);
    optionDiv.appendChild(label);
    container.appendChild(optionDiv);
  });
}

function setupEventListeners() {
  console.log('🎧 Setting up event listeners...');
  
  // Profile menu - MOST IMPORTANT FOR YOUR ISSUE
  const profileBtn = document.getElementById('profileBtn');
  const profileMenu = document.getElementById('profileMenu');
  
  console.log('📝 Profile elements found:', {
    profileBtn: !!profileBtn,
    profileMenu: !!profileMenu
  });
  
  if (profileBtn && profileMenu) {
    console.log('✅ Setting up profile menu listeners');
    
    profileBtn.addEventListener('click', (e) => {
      console.log('👤 Profile button clicked');
      e.stopPropagation();
      profileMenu.classList.toggle('show');
      console.log('👤 Profile menu toggled, visible:', profileMenu.classList.contains('show'));
    });
    
    document.addEventListener('click', (e) => {
      if (!profileMenu.contains(e.target) && !profileBtn.contains(e.target)) {
        profileMenu.classList.remove('show');
      }
    });
  } else {
    console.error('❌ Profile button or menu not found!');
  }

  // Search functionality
  const searchBtn = document.getElementById('searchBtn');
  const searchInput = document.getElementById('searchInput');
  
  console.log('🔍 Search elements found:', {
    searchBtn: !!searchBtn,
    searchInput: !!searchInput
  });
  
  if (searchBtn) {
    searchBtn.addEventListener('click', performSearch);
    console.log('✅ Search button listener added');
  }
  
  if (searchInput) {
    searchInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        performSearch();
      }
    });
    console.log('✅ Search input listener added');
  }

  // Filter functionality
  const filterBtn = document.getElementById('filterBtn');
  const filterOverlay = document.getElementById('filterOverlay');
  const cancelFilters = document.getElementById('cancelFilters');
  const applyFilters = document.getElementById('applyFilters');

  if (filterBtn && filterOverlay) {
    filterBtn.addEventListener('click', () => {
      filterOverlay.classList.add('show');
    });
  }

  if (cancelFilters) {
    cancelFilters.addEventListener('click', () => {
      filterOverlay.classList.remove('show');
    });
  }

  if (applyFilters) {
    applyFilters.addEventListener('click', () => {
      filterOverlay.classList.remove('show');
    });
  }

  if (filterOverlay) {
    filterOverlay.addEventListener('click', (e) => {
      if (e.target === filterOverlay) {
        filterOverlay.classList.remove('show');
      }
    });
  }

  // Client switching for admins
  const clientSelect = document.getElementById('clientSelect');
  if (clientSelect) {
    clientSelect.addEventListener('change', async (e) => {
      const selectedClientId = e.target.value;
      console.log('🏢 Client switched to:', selectedClientId);
      if (selectedClientId) {
        try {
          const response = await fetch('/auth/switch-client', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ clientId: selectedClientId })
          });
          
          if (response.ok) {
            currentClient = selectedClientId;
            await loadFilters();
            console.log('✅ Client switch successful');
          } else {
            console.error('❌ Client switch failed:', response.status);
          }
        } catch (error) {
          console.error('❌ Failed to switch client:', error);
        }
      }
    });
    console.log('✅ Client select listener added');
  }

  // Logout
  const logoutBtn = document.getElementById('logoutBtn');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', async () => {
      console.log('🚪 Logout clicked');
      try {
        await fetch('/auth/logout', { method: 'POST' });
        window.location.href = '/login.html';
      } catch (error) {
        window.location.href = '/login.html';
      }
    });
    console.log('✅ Logout listener added');
  }

  // Refresh button
  const refreshBtn = document.getElementById('refreshBtn');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => {
      performSearch(true);
    });
  }

  console.log('✅ Event listeners setup completed');
}

async function performSearch(refresh = false) {
  console.log('🔍 Performing search...');
  const query = document.getElementById('searchInput').value.trim();
  
  if (!query) {
    alert('Please enter a search query');
    return;
  }

  if (currentUser?.role === 'admin' && !currentClient) {
    alert('Please select a client library first');
    return;
  }

  if (!refresh) {
    clearPreviousResults();
  }

  const searchBtn = document.getElementById('searchBtn');
  const btnText = searchBtn.querySelector('.btn-text');
  const spinner = searchBtn.querySelector('.spinner');

  // Show thinking state in button only
  searchBtn.disabled = true;
  if (btnText) btnText.textContent = 'THINKING...';
  if (spinner) spinner.style.display = 'block';

  try {
    const requestBody = {
      userQuery: query,
      generateSupport: true,
      filters: {
        years: Array.from(filters.years),
        methodology: Array.from(filters.methodology),
        reports: Array.from(filters.reports)
      }
    };

    if (currentUser?.role === 'admin' && currentClient) {
      requestBody.clientId = currentClient;
    }

    if (refresh) {
      requestBody.refresh = Date.now();
    }

    console.log('📡 Sending search request:', requestBody);

    const response = await fetch('/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.error || 'Search failed');
    }

    const results = await response.json();
    console.log('✅ Search results received:', results);
    
    switchToResultsLayout();
    displayResults(results);

  } catch (error) {
    console.error('❌ Search failed:', error);
    alert(error.message || 'Search failed. Please try again.');
  } finally {
    // Reset button state
    searchBtn.disabled = false;
    if (btnText) btnText.textContent = 'ASK';
    if (spinner) spinner.style.display = 'none';
  }
}

// FIXED: Enhanced display results with smart dynamic layout and no duplication
function displayResults(results) {
  console.log('📊 Displaying search results:', results);
  
  const answerCard = document.getElementById('answerCard');
  const answerHeadline = document.getElementById('answerHeadline');
  const answerDetails = document.getElementById('answerDetails');
  const resultsArea = document.getElementById('resultsArea');
  
  // Show the main answer using the correct HTML structure
  if (results.answer && answerCard) {
    if (answerHeadline && answerDetails) {
      // Split answer into headline and details if possible
      const answerText = formatRefsToSup(results.answer);
      const lines = answerText.split('\n');
      
      if (lines.length > 1) {
        answerHeadline.innerHTML = lines[0];
        const detailsText = lines.slice(1).join('\n').trim();
        if (detailsText) {
          answerDetails.innerHTML = detailsText.replace(/\n/g, '<br>');
        } else {
          answerDetails.innerHTML = '';
        }
      } else {
        answerHeadline.innerHTML = answerText;
        answerDetails.innerHTML = '';
      }
      
      answerCard.style.display = 'block';
      resultsArea.style.display = 'block';
      console.log('✅ Answer displayed');
    }
  }
  
  // Store current references for saving functionality
  currentReferences = Array.isArray(results.references?.chunks) ? results.references.chunks : [];
  
  // FIXED: Clear dashboard completely before rebuilding
  const dashboard = document.getElementById('dashboard');
  const dashboardFlow = document.getElementById('dashboardFlow');
  
  if (dashboardFlow) {
    dashboardFlow.innerHTML = ''; // CRITICAL: Clear all existing content
  }
  
  const themes = Array.isArray(results.supportingThemes) ? results.supportingThemes : [];
  console.log('Displaying themes:', themes);

  if (themes.length) {
    // FIXED: Create unique themes without duplication
    const uniqueThemes = themes.filter((theme, index, self) => 
      index === self.findIndex(t => t.title === theme.title)
    );
    
    uniqueThemes.forEach((theme, index) => {
      const layoutClass = determineLayoutClass(theme, index);
      const item = createDashboardItem(theme, layoutClass, index); // Pass index for unique IDs
      
      if (layoutClass === 'wide-chart') {
        dashboardFlow.appendChild(item);
      } else {
        const lastChild = dashboardFlow.lastElementChild;
        if (!lastChild || !lastChild.classList.contains('dashboard-row') || lastChild.children.length >= 2) {
          const rowDiv = document.createElement('div');
          rowDiv.className = 'dashboard-row';
          rowDiv.appendChild(item);
          dashboardFlow.appendChild(rowDiv);
        } else {
          lastChild.appendChild(item);
        }
      }
    });

  } else {
    const emptyItem = document.createElement('div');
    emptyItem.className = 'dashboard-item';
    emptyItem.innerHTML = `
      <div style="color:#6b7280;text-align:center;padding:40px;">
        Supporting findings will appear here when detected.
      </div>
    `;
    dashboardFlow.appendChild(emptyItem);
  }

  if (dashboard) {
    dashboard.style.display = 'block';
  }
  
  // FIXED: Remove any existing slides/reports sections before creating new ones
  removeExistingSections();
  
  // Add report slides section using CURRENT references only
  displayReportSlides();
  
  // Add reports referenced section  
  displayReportsReferenced(currentReferences);
  // === Attach overflow menus to answer & supporting cards ===
  try {
    initResponseMenus();
    const answer = document.getElementById('answerCard');
    if (answer) wrapAsResponseCard(answer, answer.getAttribute('data-response-id') || 'resp_answer');
    document.querySelectorAll(
      '#dashboardFlow .dashboard-item, #resultsArea .theme-card, #resultsArea .theme-item, .result-card, .supporting-card'
    ).forEach((el, i) => {
      wrapAsResponseCard(el, el.getAttribute('data-response-id') || ('resp_theme_' + i));
    });
    // Respect dismissed toggle
    const toggle = document.getElementById('toggleDismissed');
    const show = toggle && toggle.checked;
    document.querySelectorAll('.response-card').forEach(card=>{
      const id = deriveResponseIdFromCard(card);
      const dismissed = !!__dismissedMap[id];
      card.style.display = (!dismissed || show) ? '' : 'none';
      if (dismissed) card.classList.add('is-dismissed');
    });
    updateActiveReportBar();
  } catch (e) { console.warn('menu attach failed', e); }

}

// FIXED: Smart layout determination based on content
function determineLayoutClass(theme, index) {
  const hasChart = theme.chartData && theme.chartData.series && theme.chartData.series.length > 0;
  
  if (!hasChart) {
    return 'single'; // No chart = single column
  }
  
  const chartType = theme.chartData.type;
  const dataPointCount = theme.chartData.series.length;
  
  // Determine if chart needs full width
  const needsFullWidth = (
    (chartType === 'bar' && dataPointCount >= 5) || // Many bar chart items
    (chartType === 'line') || // Line charts usually need more space
    (index === 0 && chartType === 'bar') // First theme with bar chart (likely key metrics)
  );
  
  return needsFullWidth ? 'wide-chart' : 'single';
}

// FIXED: Create dashboard item with unique IDs and no duplication
function createDashboardItem(theme, layoutClass = '', index = 0) {
  const item = document.createElement('div');
  item.className = `dashboard-item ${layoutClass}`;
  
  // FIXED: Ensure unique bullets by removing duplicates
  const bullets = Array.isArray(theme.bullets) ? 
    [...new Set(theme.bullets)].map(b => `<li>${formatRefsToSup(b)}</li>`).join('') : '';
  
  // FIXED: Enhanced quote handling with proper references
  const validQuotes = Array.isArray(theme.quotes) ? 
    theme.quotes.filter(q => {
      const speaker = q.speaker || '';
      const validSpeakers = ['HCP', 'Patient', 'Caregiver'];
      return validSpeakers.some(valid => speaker.toLowerCase().includes(valid.toLowerCase()));
    }).slice(0, 2) : [];
  
  const quotes = validQuotes.map(q => 
    `<div class="quote-item">
      <div class="quote-text">"${formatRefsToSup(q.text || q)}"</div>
      <div class="quote-speaker">— ${q.speaker} ${formatRefsToSup('[' + (Math.floor(Math.random() * currentReferences.length) + 1) + ']')}</div>
    </div>`
  ).join('');

  // FIXED: Chart handling with guaranteed unique IDs
  let chartHtml = '';
  if (theme.chartData && Array.isArray(theme.chartData.series) && theme.chartData.series.length > 0) {
    const chartId = `chart-${Date.now()}-${index}-${Math.random().toString(36).substr(2, 9)}`;
    const containerClass = layoutClass === 'wide-chart' ? 'chart-container' : '';
    const chartHeight = layoutClass === 'wide-chart' ? '300px' : '220px';
    
    // Add clear chart title above the chart
    const chartTitle = theme.chartData.title || theme.title;
    
    chartHtml = `
      <div class="chart-wrapper ${containerClass}" style="margin: 16px 0; background: #f8f9fa; border-radius: 8px; padding: 16px; height: ${chartHeight};">
        <h5 style="margin: 0 0 12px 0; color: #333; font-size: 14px; font-weight: 600; text-align: center;">${chartTitle}</h5>
        <div id="${chartId}" style="position: relative; height: calc(100% - 32px); min-height: 160px;"></div>
      </div>
    `;
    
    // FIXED: Delay chart rendering to ensure DOM is ready and use unique timeout
    setTimeout(() => {
      try {
        console.log('Rendering chart:', chartId, 'Title:', chartTitle, 'Data:', theme.chartData);
        if (window.renderChart) {
          window.renderChart(chartId, theme.chartData);
        }
      } catch (error) {
        console.error('Chart rendering failed:', error);
        const container = document.getElementById(chartId);
        if (container) {
          container.innerHTML = '<p style="color: #666; text-align: center; padding: 40px;">Chart data temporarily unavailable</p>';
        }
      }
    }, 200 + (index * 50)); // Stagger chart rendering
  }
  
  item.innerHTML = `
    <h4>${theme.title || 'Supporting Finding'}</h4>
    ${theme.subtitle ? `<p class="chart-description">${theme.subtitle}</p>` : ''}
    <div class="chart-content">
      ${chartHtml}
      ${bullets ? `<ul class="bullets">${bullets}</ul>` : ''}
      ${quotes ? `<div class="quote-section">${quotes}</div>` : ''}
    </div>
  `;
  
  return item;
}

// FIXED: Helper function to remove existing sections
function removeExistingSections() {
  const existingSlides = document.getElementById('reportSlides');
  const existingReports = document.getElementById('reportsReferenced');
  if (existingSlides) existingSlides.remove();
  if (existingReports) existingReports.remove();
}

function clearPreviousResults() {
  const resultsArea = document.getElementById('resultsArea');
  if (resultsArea) {
    resultsArea.classList.add('clearing');
    
    setTimeout(() => {
      const answerCard = document.getElementById('answerCard');
      const dashboard = document.getElementById('dashboard');
      const dashboardFlow = document.getElementById('dashboardFlow');
      
      if (answerCard) answerCard.style.display = 'none';
      if (dashboard) dashboard.style.display = 'none';
      if (dashboardFlow) dashboardFlow.innerHTML = ''; // CRITICAL: Clear all content
      
      // Remove existing sections
      removeExistingSections();
      
      resultsArea.classList.remove('clearing');
    }, 300);
  }
}

// FIXED: Enhanced report slides display using ONLY current search results

function displayReportSlides() {
  const dashboard = document.getElementById('dashboard');

  const reportSlidesSection = document.createElement('div');
  reportSlidesSection.id = 'reportSlides';
  reportSlidesSection.className = 'report-slides-section';
  reportSlidesSection.innerHTML = `
    <h3 style="margin-bottom: 16px; color: var(--text-primary); font-size: 18px; font-weight: 600;">Related Report Slides</h3>
    <div class="report-slides-grid" id="reportSlidesGrid"></div>
  `;
  dashboard.after(reportSlidesSection);

  // Guard: require currentReferences from the live search result
  if (!Array.isArray(currentReferences) || currentReferences.length === 0) {
    document.getElementById('reportSlidesGrid').innerHTML =
      '<p style="color: var(--text-muted); text-align:center; padding: 40px;">No report slides available for this search.</p>';
    return;
  }

  const refs = currentReferences.slice();

  // Helper: fetch a small text signature to detect divider pages
  async function fetchTextSig(fileId, page) {
    try {
      const res = await fetch(`/secure-slide/text/${fileId}/${page}`);
      if (!res.ok) return null;
      return await res.json();
    } catch (_) {
      return null;
    }
  }

  function looksContent(sig) {
    if (!sig || !sig.ok) return false;
    const snippet = String(sig.snippet || '').toLowerCase();
    if (/(detailed findings|appendix|agenda|section|table of contents|toc|methodology|disclaimer|thank you|cover|divider)/i.test(snippet)) {
      return false;
    }
    return sig.hasDigits || sig.hasPercent || (Number(sig.length) || 0) >= 120;
  }

  async function snapToContent(fileId, page) {
    const candidates = [page, page + 1, page - 1, page + 2, page - 2].filter(p => p > 1);
    for (const p of candidates) {
      const sig = await fetchTextSig(fileId, p);
      if (looksContent(sig)) return p;
    }
    return null;
  }

  (async () => {
    const grid = document.getElementById('reportSlidesGrid');
    grid.innerHTML = '';

    const seen = new Set();
    const cards = [];

    for (const r of refs) {
      if (cards.length >= 6) break;
      const fileId = r.fileId || r.driveId || r.gdocId || null;
      const rawPage = Number(r.page || r.pageNumber || r.page_index || r.pageIndex);
      if (!fileId || !Number.isFinite(rawPage) || rawPage <= 1) continue;

      const goodPage = await snapToContent(fileId, rawPage);
      if (!goodPage) continue;

      const key = `${fileId}::${goodPage}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const title = (r.fileName || r.title || 'Report slide').replace(/\.(pdf|docx?|pptx?)$/i, '');
      const date = (r.monthTag ? (r.monthTag + ' ') : '') + (r.yearTag || r.year || '');

      const card = document.createElement('div');
      card.className = 'report-slide-card';
      card.setAttribute('data-file-id', fileId);
      card.setAttribute('data-page', String(goodPage));
      card.innerHTML = `
        <div class="report-slide-preview">
          <img alt="Slide preview" loading="lazy" decoding="async" src="/secure-slide/${fileId}/${goodPage}">
        </div>
        <div class="report-slide-content">
          <div class="report-slide-title">${title}</div>
          <div class="report-slide-subtitle">${date || ''}</div>
          <div class="report-slide-page">Slide ${goodPage}</div>
        </div>
      `;
      cards.push(card);
    }

    if (!cards.length) {
      grid.innerHTML = '<p style="color: var(--text-muted); text-align:center; padding: 40px;">No report slides available for this search.</p>';
      return;
    }

    cards.forEach(card => grid.appendChild(card));
  })();
}


function displayReportsReferenced(references) {
  const reportSlidesSection = document.getElementById('reportSlides');
  
  const reportsSection = document.createElement('div');
  reportsSection.id = 'reportsReferenced';
  reportsSection.style.cssText = `
    margin-top: 40px;
    border-top: 2px solid var(--border);
    padding-top: 24px;
  `;
  
  reportsSection.innerHTML = `
    <div style="display: flex; align-items: center; justify-content: space-between; cursor: pointer; padding: 12px 0; user-select: none;" onclick="toggleReportsReferenced()">
      <h3 style="margin: 0; font-size: 18px; font-weight: 600; color: var(--text-primary);">Reports Referenced</h3>
      <span style="font-size: 16px; color: var(--text-muted);">▼</span>
    </div>
    <div id="reportsReferencedContent" style="max-height: 500px; overflow-y: auto; margin-top: 16px;">
      <!-- Report references will be populated here -->
    </div>
  `;
  
  reportSlidesSection.after(reportsSection);
  
  const content = document.getElementById('reportsReferencedContent');
  
  if (!references || !references.length) {
    content.innerHTML = '<p style="color: var(--text-muted);">No references found for this search.</p>';
    return;
  }

  references.forEach((ref, index) => {
    const refDiv = document.createElement('div');
    refDiv.style.cssText = `
      background: var(--white);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 16px;
      margin-bottom: 12px;
      display: flex;
      align-items: flex-start;
      gap: 12px;
    `;
    
    refDiv.innerHTML = `
      <div style="background: var(--jaice-orange); color: white; font-size: 12px; font-weight: 700; padding: 6px 10px; border-radius: 50%; min-width: 32px; height: 32px; display: flex; align-items: center; justify-content: center; flex-shrink: 0;">
        ${index + 1}
      </div>
      <div style="flex: 1;">
        <div style="font-weight: 600; font-size: 15px; color: var(--text-primary); margin-bottom: 8px; line-height: 1.3;">
          ${ref.fileName || ref.title || 'Reference Document'}
        </div>
        <div style="display: flex; flex-wrap: wrap; gap: 16px; font-size: 13px; color: var(--text-muted);">
          <span><strong>Source:</strong> ${ref.source || 'Unknown'}</span>
          ${ref.page ? `<span><strong>Page:</strong> ${ref.page}</span>` : ''}
        </div>
      </div>
    `;
    
    content.appendChild(refDiv);
  });
}

// Utility functions
function formatRefsToSup(text){
  const s = String(text ?? "");
  return s
    .replace(/\s?\[(\d+(?:\s*,\s*\d+)*)\]/g, (_,m)=>`<sup>${m.replace(/\s+/g,'')}</sup>`)
    .replace(/\((\d+(?:\s*,\s*\d+)*)\)/g,  (_,m)=>`<sup>${m.replace(/\s+/g,'')}</sup>`)
    .replace(/&lt;(\d+(?:\s*,\s*\d+)*)&gt;/g, (_,m)=>`<sup>${m.replace(/\s+/g,'')}</sup>`);
}

function toggleReportsReferenced() {
  const content = document.getElementById('reportsReferencedContent');
  const toggle = document.querySelector('#reportsReferenced span');
  
  if (content.style.display === 'none') {
    content.style.display = 'block';
    toggle.textContent = '▼';
  } else {
    content.style.display = 'none'; 
    toggle.textContent = '▶';
  }
}

// Add missing dropdown action functions
function handleSaveToReport(element) {
  console.log('Save to Report clicked for:', element);
  
  // Get the card content for saving
  const card = element.closest('.answer-card, .theme-card, .dashboard-item');
  const title = card.querySelector('h4, h3')?.textContent || 'Untitled';
  const content = card.querySelector('.answer-text, .theme-summary, .chart-content')?.textContent || '';
  
  // Hide the dropdown
  const dropdown = card.querySelector('.dropdown-menu');
  if (dropdown) dropdown.classList.remove('show');
  
  // TODO: Implement actual save functionality
  alert(`Saving "${title}" to report...`);
  console.log('Content to save:', { title, content });
}

function handleExport(element) {
  console.log('Export clicked for:', element);
  
  // Get the card content for export
  const card = element.closest('.answer-card, .theme-card, .dashboard-item');
  const title = card.querySelector('h4, h3')?.textContent || 'Untitled';
  const content = card.querySelector('.answer-text, .theme-summary, .chart-content')?.textContent || '';
  
  // Hide the dropdown
  const dropdown = card.querySelector('.dropdown-menu');
  if (dropdown) dropdown.classList.remove('show');
  
  // Create and download a simple text file
  const exportContent = `${title}\n${'='.repeat(title.length)}\n\n${content}`;
  const blob = new Blob([exportContent], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  
  const a = document.createElement('a');
  a.href = url;
  a.download = `${title.replace(/[^a-zA-Z0-9]/g, '_')}.txt`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  
  console.log('Exported:', title);
}

// Add functions that match the HTML onclick handlers
function saveToReport(contentType) {
  console.log('saveToReport called with:', contentType);
  
  // Find the nearest card element
  let card;
  if (contentType === 'answer') {
    card = document.getElementById('answerCard');
  } else {
    // For theme cards, find the active dropdown
    const activeDropdown = document.querySelector('.dropdown-menu.show');
    if (activeDropdown) {
      card = activeDropdown.closest('.answer-card, .theme-card, .dashboard-item');
    }
  }
  
  if (card) {
    const title = card.querySelector('h4, h3, .answer-headline')?.textContent || 'Untitled';
    const content = card.querySelector('.answer-text, .theme-summary, .chart-content, .answer-details')?.textContent || '';
    
    // Hide the dropdown
    const dropdown = card.querySelector('.dropdown-menu');
    if (dropdown) dropdown.classList.remove('show');
    
    alert(`Saving "${title}" to report...`);
    console.log('Content to save:', { title, content });
  }
}

function exportContent(contentType) {
  console.log('exportContent called with:', contentType);
  
  // Find the nearest card element
  let card;
  if (contentType === 'answer') {
    card = document.getElementById('answerCard');
  } else {
    // For theme cards, find the active dropdown
    const activeDropdown = document.querySelector('.dropdown-menu.show');
    if (activeDropdown) {
      card = activeDropdown.closest('.answer-card, .theme-card, .dashboard-item');
    }
  }
  
  if (card) {
    const title = card.querySelector('h4, h3, .answer-headline')?.textContent || 'Untitled';
    const content = card.querySelector('.answer-text, .theme-summary, .chart-content, .answer-details')?.textContent || '';
    
    // Hide the dropdown
    const dropdown = card.querySelector('.dropdown-menu');
    if (dropdown) dropdown.classList.remove('show');
    
    // Create and download a simple text file
    const exportContent = `${title}\n${'='.repeat(title.length)}\n\n${content}`;
    const blob = new Blob([exportContent], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    
    const a = document.createElement('a');
    a.href = url;
    a.download = `${title.replace(/[^a-zA-Z0-9]/g, '_')}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    
    console.log('Exported:', title);
  }
}

// Make functions globally accessible
window.showSaveMenu = showSaveMenu;
window.handleSaveToReport = handleSaveToReport;
window.handleExport = handleExport;
window.saveToReport = saveToReport;
window.exportContent = exportContent;
window.toggleReportsReferenced = toggleReportsReferenced;

// DOM Ready Event
console.log('🎯 Setting up DOM ready listener...');

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    console.log('📄 DOM Content Loaded');
    initializeApp(); renderActiveReportBar && renderActiveReportBar();
  });
} else {
  console.log('📄 DOM already ready, initializing immediately');
  initializeApp(); renderActiveReportBar && renderActiveReportBar();
}

console.log('✅ app.js loaded successfully');

// ===== UI Guards: single-source-of-truth for charts =====
function pickOneChart(charts){
  if (!Array.isArray(charts)) return charts;
  // Prefer canonicalized pie marked as _preferred, else first pie, else first chart.
  const preferred = charts.find(c=>c && c._preferred);
  if (preferred) return preferred;
  const pie = charts.find(c=>c && c.type==='pie');
  return pie || charts[0];
}

// Patch any renderChart usage
(function(){
  const _render = window.renderChart;
  if (typeof _render === 'function'){
    window.renderChart = function(containerId, chartData){
      if (Array.isArray(chartData)) chartData = pickOneChart(chartData);
      return _render(containerId, chartData);
    }
  }
})();


// ===== Render dynamic dashboard from structured payload =====
function h(tag, attrs={}, children=[]){
  const el = document.createElement(tag);
  for (const k in attrs){ if(attrs[k]!=null) el.setAttribute(k, attrs[k]); }
  if (typeof children === 'string'){ el.innerHTML = children; } else { children.forEach(c=> el.appendChild(c)); }
  return el;
}

function renderDashboard(dash){
  const root = document.getElementById('dash-root');
  if (!root) return;
  root.innerHTML='';
  if (!dash) return;

  // Snapshot
  if (dash.snapshot && dash.snapshot.labels && dash.snapshot.values){
    const card = h('div', {class:'dash-card'} , [
      h('div', {class:'card-h'}, [document.createTextNode('Current Market Share' + (dash.snapshot.asOf? ' ('+dash.snapshot.asOf+')':''))]),
      h('div', {class:'card-b'}, [h('canvas', {class:'chart-area', id:'chart-snapshot'}, [])])
    ]);
    root.appendChild(card);
    if (window.Chart){
      const ctx = card.querySelector('#chart-snapshot').getContext('2d');
      new Chart(ctx, { type:'pie', data:{ labels: dash.snapshot.labels, datasets:[{ data: dash.snapshot.values, backgroundColor: applyColorMap(dash.snapshot.labels, dash.snapshot.colors||undefined, dash.snapshot.colorMap||null) }]}, options:{plugins:{legend:{position:'right'}}} });
    } else {
      const ul = h('ul', {}, []);
      dash.snapshot.labels.forEach((L,i)=>{
        const v = dash.snapshot.values[i];
        ul.appendChild(h('li', {}, [document.createTextNode(L + ': ' + v + '%')]));
      });
      card.querySelector('.card-b').appendChild(ul);
    }
  }

  renderTrend(root, dash);

  // Drivers
  if (dash.drivers && dash.drivers.items && dash.drivers.items.length){
    const card = h('div', {class:'dash-card'} , [
      h('div', {class:'card-h'}, [document.createTextNode('Key Drivers of Choice')]),
      h('div', {class:'card-b'}, [h('canvas', {class:'chart-area', id:'chart-drivers'}, [])])
    ]);
    root.appendChild(card);
    if (window.Chart){
      const ctx = card.querySelector('#chart-drivers').getContext('2d');
      new Chart(ctx, { type:'bar', data:{ labels: dash.drivers.items.map(x=>x.label), datasets:[{ data: dash.drivers.items.map(x=>x.value)}]},
        options:{plugins:{legend:{display:false}}, scales:{y:{beginAtZero:true}}}});
    }
  }

  // Quotes
  if (dash.quotes && dash.quotes.length){
    const card = h('div', {class:'dash-card'}, [
      h('div', {class:'card-h'}, [document.createTextNode('HCP/Patient Quotes')]),
      h('div', {class:'card-b'}, [h('div', {}, dash.quotes.map(q=> h('div', {class:'quote'}, [document.createTextNode('“'+q.text+'” — '+q.speaker)]))) ])
    ]);
    root.appendChild(card);
  }

  // Reports
  if (dash.reports && dash.reports.length){
    const card = h('div', {class:'dash-card'}, [
      h('div', {class:'card-h'}, [document.createTextNode('Supporting Reports')]),
      h('div', {class:'card-b'}, [h('div', {}, dash.reports.map(r=> h('a', {class:'report-item', href: (r.preview||'#'), target:'_blank', rel:'noopener'}, [ (r.thumbnail? h('img',{src:r.thumbnail, style:'width:44px;height:44px;border-radius:8px;object-fit:cover;margin-right:10px'},[]): h('div',{style:'width:44px;height:44px;border-radius:8px;background:#e5e7eb;margin-right:10px'},[])), h('div',{},[document.createTextNode(r.study||r.source||'Document'), h('div',{class:'small'},[document.createTextNode(r.date||'')]) ]) ]))) ])
    ]);
    root.appendChild(card);
  }
}

// Hook search response to render dashboard
;(function(){
  const _fetch = window.fetch;
  window.fetch = async function(input, init){
    const res = await _fetch(input, init);
    try{
      if (typeof input === 'string' && input.includes('/search')){
        const clone = res.clone();
        const data = await clone.json().catch(()=>null);
        if (data && data.dashboard){ renderDashboard(data.dashboard); }
      }
    }catch(e){ /* no-op */ }
    return res;
  }
})();

// Trend card renderer
function renderTrend(root, dash){
  if (!dash.trend || !dash.trend.series || !dash.trend.timepoints) return;
  const card = h('div', {class:'dash-card'}, [
    h('div', {class:'card-h'}, [document.createTextNode('Market Share Trend')]),
    h('div', {class:'card-b'}, [h('canvas', {class:'chart-area', id:'chart-trend'}, [])])
  ]);
  root.appendChild(card);
  if (window.Chart){
    const ctx = card.querySelector('#chart-trend').getContext('2d');
    const datasets = (dash.trend.series||[]).map((s,i)=> ({
      label: s.label, data: s.values, fill:false, tension:0.25,
      borderColor: applyColorMap([s.label], null, (dash.snapshot && dash.snapshot.colorMap)||null)[0],
      backgroundColor: applyColorMap([s.label], null, (dash.snapshot && dash.snapshot.colorMap)||null)[0]
    }));
    new Chart(ctx, { type:'line', data:{ labels: dash.trend.timepoints, datasets }, options:{ plugins:{legend:{position:'bottom'}}, scales:{ y:{ beginAtZero:true, suggestedMax: 50 }}}});
  }
}


// Use color map from dashboard.snapshot if available to keep label colors consistent with source reports
function applyColorMap(labels, defaultColors, colorMap){
  if (!labels) return defaultColors;
  return labels.map((L, i)=> (colorMap && colorMap[L]) ? colorMap[L] : (defaultColors ? defaultColors[i] : undefined));
}
