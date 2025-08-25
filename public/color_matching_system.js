// Intelligent Color Matching System for Report Data (completed build)
(function (global) {
  class ChartColorMatcher {
    constructor() {
      // High-contrast palette tuned for Jaice
      this.orangeGrayPalette = [
        '#ff7a00','#4a5568','#e86900','#a0aec0','#ff9500','#2d3748','#ffb84d','#718096',
        '#cc5500','#e2e8f0','#ff6600','#9ca3af',
        '#ff9f1a','#5a626d','#ffa94d','#cbd5e1','#e67e22','#1f2937'
      ];

      // Product & taxonomy color map
      this.productColors = {
        'evrysdi':'#ff7a00','risdiplam':'#ff7a00',
        'spinraza':'#2563eb','nusinersen':'#2563eb',
        'zolgensma':'#16a34a','onasemnogene':'#16a34a',
        'untreated':'#94a3b8','no treatment':'#94a3b8','treatment naive':'#94a3b8',
        'other':'#6366f1','others':'#6366f1','new':'#f59e0b','emerging':'#f59e0b',
        'generic':'#8b5cf6','biosimilar':'#8b5cf6',
        'efficacy':'#059669','safety':'#dc2626','access':'#7c3aed','cost':'#ea580c',
        'convenience':'#0891b2','administration':'#0891b2',
        'adult':'#1f2937','pediatric':'#f59e0b','infant':'#ec4899','caregiver':'#059669',
        'hcp':'#2563eb','physician':'#2563eb'
      };

      this.colorPatterns = [
        { pattern: /orange/i, color: '#ff7a00' },
        { pattern: /blue/i, color: '#2563eb' },
        { pattern: /green/i, color: '#16a34a' },
        { pattern: /red/i, color: '#dc2626' },
        { pattern: /purple|violet/i, color: '#7c3aed' },
        { pattern: /yellow|amber/i, color: '#f59e0b' },
        { pattern: /gray|grey/i, color: '#6b7280' },
        { pattern: /cyan|turquoise/i, color: '#0891b2' },
        { pattern: /pink/i, color: '#ec4899' },
        { pattern: /emerald/i, color: '#059669' }
      ];
    }

    getColorsForChart(chartData, chartType = 'bar') {
      // 1) If a color map is provided by upstream (parsed from the report), use it
      const reportMap = (chartData && (chartData.colorMap || (chartData.context && chartData.context.reportColorMap))) || null;
      const labels = (chartData.series || []).map(s => s.label ?? String(s));
      if (reportMap && typeof reportMap === 'object') {
        const bg = [], bd = [];
        labels.forEach((label, idx) => {
          const key = String(label || '').toLowerCase().trim();
          const color = reportMap[key] || reportMap[label] || null;
          const fallback = this.findBestColorMatch(label || '', new Set()) || this.orangeGrayPalette[idx % this.orangeGrayPalette.length];
          const final = color || fallback;
          bg.push(chartType === 'pie' ? final : this.addTransparency(final, 0.85));
          bd.push(chartType === 'pie' ? '#fff' : final);
        });
        return { backgroundColor: bg, borderColor: bd };
      }
      // 2) Otherwise, infer based on label taxonomy and palette
      const colors = this.matchColors(labels, chartType);
      return { backgroundColor: colors.background, borderColor: colors.border };
    };

    matchColors(labels, chartType = 'bar') {
      const backgroundColor = [];
      const borderColor = [];
      const used = new Set();

      labels.forEach((label, idx) => {
        let c = this.findBestColorMatch(label || '', used);
        if (!c) c = this.orangeGrayPalette[idx % this.orangeGrayPalette.length];

        const final = this.ensureContrast(c, idx);
        backgroundColor.push(chartType === 'pie' ? final : this.addTransparency(final, 0.85));
        borderColor.push(chartType === 'pie' ? '#fff' : final);
        used.add(final);
      });

      return { background: backgroundColor, border: borderColor };
    }

    findBestColorMatch(label, used) {
      const lower = (label || '').toLowerCase();
      for (const [k, v] of Object.entries(this.productColors)) {
        if (lower.includes(k)) return v;
      }
      for (const p of this.colorPatterns) {
        if (p.pattern.test(label)) return p.color;
      }
      return null;
    }

    ensureContrast(color, index) {
      if (index % 4 === 0 && index > 0) {
        return this.getContrastingColor(color);
      }
      return color;
    }

    getContrastingColor(base) {
      const oranges = ['#ff7a00','#e86900','#ff9500','#ffb84d','#cc5500','#ff6600'];
      const grays   = ['#4a5568','#a0aec0','#2d3748','#718096','#e2e8f0','#9ca3af'];
      return oranges.includes(base)
        ? grays[Math.floor(Math.random() * grays.length)]
        : oranges[Math.floor(Math.random() * oranges.length)];
    }

    addTransparency(hex, alpha = 0.85) {
      const r = parseInt(hex.slice(1,3),16);
      const g = parseInt(hex.slice(3,5),16);
      const b = parseInt(hex.slice(5,7),16);
      return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    }

    analyzeReportContext(reportText = '', chartTitle = '') {
      const colorHints = [];
      const mentions = reportText.match(/\b(orange|blue|green|red|purple|yellow|gray|grey|violet|amber|cyan|pink|emerald)\b/gi);
      if (mentions) colorHints.push(...mentions);

      const productMentions = Object.keys(this.productColors).filter(p =>
        reportText.toLowerCase().includes(p)
      );

      return {
        colorHints,
        productMentions,
        suggestedPalette: this.generateContextualPalette(colorHints, productMentions)
      };
    }

    generateContextualPalette(colorHints = [], productMentions = []) {
      // Prioritize product colors first
      const palette = [];
      const seen = new Set();

      productMentions.forEach(p => {
        const c = this.productColors[p];
        if (c && !seen.has(c)) { palette.push(c); seen.add(c); }
      });

      // Then any explicit color words
      colorHints.forEach(h => {
        const key = h.toLowerCase();
        const map = {
          orange:'#ff7a00', blue:'#2563eb', green:'#16a34a', red:'#dc2626',
          purple:'#7c3aed', violet:'#7c3aed', yellow:'#f59e0b', amber:'#f59e0b',
          gray:'#6b7280', grey:'#6b7280', cyan:'#0891b2', pink:'#ec4899', emerald:'#059669'
        };
        const c = map[key];
        if (c && !seen.has(c)) { palette.push(c); seen.add(c); }
      });

      // Fill remainder from base palette
      for (const c of this.orangeGrayPalette) {
        if (!seen.has(c)) { palette.push(c); seen.add(c); }
        if (palette.length >= 12) break;
      }
      return palette;
    }

    static pickTextColor(bgHex) {
      // luminance heuristic
      const r = parseInt(bgHex.slice(1,3),16);
      const g = parseInt(bgHex.slice(3,5),16);
      const b = parseInt(bgHex.slice(5,7),16);
      const luminance = (0.2126*r + 0.7152*g + 0.0722*b);
      return luminance < 140 ? '#fff' : '#111';
    }
  }

  // UMD export
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = ChartColorMatcher;
  } else {
    global.ChartColorMatcher = ChartColorMatcher;
  }
})(typeof window !== 'undefined' ? window : globalThis);