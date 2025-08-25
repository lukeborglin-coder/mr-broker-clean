// Enhanced chart rendering function with better color differentiation and layout fixes
(function(){
  if (!window.chartInstances) window.chartInstances = new Map();

  function ensureMatcher() {
    try {
      if (!window.__chartColorMatcher) {
        if (typeof ChartColorMatcher === 'function') {
          window.__chartColorMatcher = new ChartColorMatcher();
        } else {
          window.__chartColorMatcher = null;
        }
      }
      return window.__chartColorMatcher;
    } catch(e) {
      console.warn('Color matcher unavailable:', e);
      return null;
    }
  }

  window.renderChart = function(containerId, chartData) {
    const container = document.getElementById(containerId);
    if (!container) {
      console.warn('Chart container not found:', containerId);
      return;
    }

    // Destroy prior instance if present
    if (window.chartInstances.has(containerId)) {
      const existingChart = window.chartInstances.get(containerId);
      try { existingChart.destroy(); } catch(e) { console.warn('Destroy error:', e); }
      window.chartInstances.delete(containerId);
    }

    // Clear container content to prevent duplication
    container.innerHTML = '';

    if (!chartData || !chartData.series || chartData.series.length === 0) {
      container.innerHTML = '<p style="color:#666;text-align:center;padding:20px;">No chart data available</p>';
      return;
    }

    // Create canvas
    const canvas = document.createElement('canvas');
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.id = containerId + '_canvas';
    container.appendChild(canvas);

    const labels = chartData.series.map(s => s.label);
    const data = chartData.series.map(s => s.value);

    // Decide chart type
    let chartType = 'bar';
    const total = data.reduce((a,b)=>a+b,0);
    if (chartData.type === 'pie' && total >= 90 && total <= 110) chartType = 'pie';
    else if (chartData.type === 'line') chartType = 'line';

    // Colors via matcher if present
    let backgroundColor, borderColor;
    const matcher = ensureMatcher();
    if (matcher) {
      const colors = matcher.getColorsForChart(chartData, chartType);
      backgroundColor = colors.backgroundColor;
      borderColor = colors.borderColor;
    } else {
      // Fallback palette
      const hc = ['#ff7a00','#4a5568','#e86900','#a0aec0','#ff9500','#2d3748','#ffb84d','#718096'];
      backgroundColor = labels.map((_,i)=>hc[i%hc.length]);
      borderColor = backgroundColor;
    }

    const truncatedLabels = labels.map(l => l.length>15 ? (l.slice(0,12)+'...') : l);

    const chartConfig = {
      type: chartType,
      data: {
        labels: truncatedLabels,
        datasets: [{
          label: '',
          data,
          backgroundColor,
          borderColor,
          borderWidth: chartType === 'pie' ? 2 : 1,
          fill: chartType === 'line' ? false : true
        }]
      },
      plugins: (typeof ChartDataLabels !== 'undefined') ? [ChartDataLabels] : [],
      options: {
        responsive: true,
        maintainAspectRatio: false,
        layout: { padding: { top: 30, bottom: chartType==='pie'?10:40, left: 10, right: chartType==='pie'?80:10 } },
        plugins: {
          legend: {
            display: chartType === 'pie',
            position: 'right',
            labels: {
              font: { size: 11 },
              padding: 12,
              usePointStyle: true,
              generateLabels: function(chart) {
                return chart.data.labels.map((_,i)=>({
                  text: labels[i],
                  fillStyle: chart.data.datasets[0].backgroundColor[i],
                  hidden: false,
                  index: i
                }));
              }
            }
          },
          tooltip: {
            callbacks: {
              title: function(ctx){
                const i = ctx[0].dataIndex;
                return labels[i]; // full label on hover
              },
              label: function(ctx){ const v = ctx.parsed ?? ctx.raw; return (v%1===0? v : v.toFixed(1)) + '%'; }
            }
          },
          datalabels: (typeof ChartDataLabels !== 'undefined') ? {
            display: true,
            color: function(context) {
              const bg = context.dataset.backgroundColor[context.dataIndex];
              const darks = ['#4a5568','#2d3748','#718096'];
              return darks.includes(bg) ? '#fff' : (chartType==='pie' ? '#fff' : '#333');
            },
            font: { weight: 'bold', size: 12 },
            formatter: function(v){ return (v%1===0? v : v.toFixed(1)) + '%'; },
            anchor: chartType === 'pie' ? 'center' : 'end',
            align: chartType === 'pie' ? 'center' : 'top',
            offset: chartType === 'pie' ? 0 : -8,
            clip: false
          } : undefined
        },
        scales: (chartType === 'pie') ? {} : {
          y: { display: false, grid: { display: false }, border: { display: false } },
          x: { 
            grid: { display: false }, 
            border: { display: false }, 
            ticks: { 
              maxRotation: 0, minRotation: 0, autoSkip: true, autoSkipPadding: 6, 
              callback: function(value, index) { 
                const l = truncatedLabels[index] || ''; 
                return l; 
              },
              font: { size: 10 } 
            } 
          }
        },
        onHover: function(evt, active, chart) {
          chart.canvas.style.cursor = (active && active.length>0) ? 'pointer' : 'default';
          if (active && active.length>0 && chartType!=='pie') {
            const idx = active[0].index;
            chart.canvas.title = `${labels[idx]}: ${data[idx]}%`;
          }
        }
      }
    };

    if (typeof Chart === 'undefined') {
      container.innerHTML = '<p style="color:#666;text-align:center;padding:20px;">Chart.js not loaded</p>';
      return;
    }

    try {
      if (typeof ChartDataLabels !== 'undefined') Chart.register(ChartDataLabels);
      
      // Get context safely
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        throw new Error('Cannot get canvas context');
      }
      
      // Add safe onComplete callback to prevent undefined ctx errors
      if (!chartConfig.options) chartConfig.options = {};
      if (!chartConfig.options.animation) chartConfig.options.animation = {};
      chartConfig.options.animation.onComplete = function(animation) {
        // Safe callback that checks for context existence
        if (animation && animation.chart && animation.chart.ctx) {
          // Chart is ready and context exists
          console.log('Chart animation completed for:', containerId);
        }
      };
      
      const instance = new Chart(ctx, chartConfig);
      window.chartInstances.set(containerId, instance);

      if (window.ResizeObserver) {
        const ro = new ResizeObserver(() => {
          try {
            if (instance && !instance.destroyed) {
              instance.resize();
            }
          } catch (e) {
            console.warn('Chart resize failed:', e);
          }
        });
        ro.observe(container);
      }
    } catch (e) {
      console.error('Chart creation failed:', e);
      container.innerHTML = '<p style="color:#666;text-align:center;padding:20px;">Chart rendering failed</p>';
    }
  };
})();