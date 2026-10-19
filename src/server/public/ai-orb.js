/**
 * AiOrb - Interactive WebGL Holographic AI Intelligence Orb
 * Features raymarched iridescent fluid refraction, chromatic caustics,
 * magnetic cursor tracking, click/tap ripple shockwaves, and turn-state pulsing.
 */
(function (global) {
  'use strict';

  const VERTEX_SHADER = `
    attribute vec2 a_position;
    void main() {
      gl_Position = vec4(a_position, 0.0, 1.0);
    }
  `;

  const FRAGMENT_SHADER = `
    precision highp float;

    uniform vec2 u_resolution;
    uniform vec2 u_mouse;
    uniform float u_time;
    uniform float u_hover;
    uniform float u_shockwave;
    uniform float u_activity;

    // Prismatic chromatic palette: deep sapphire, cyan, magenta-violet, and gold
    vec3 palette(float t) {
      vec3 a = vec3(0.55, 0.50, 0.60);
      vec3 b = vec3(0.50, 0.45, 0.55);
      vec3 c = vec3(1.0, 1.0, 1.0);
      vec3 d = vec3(0.05, 0.35, 0.68);
      return a + b * cos(6.28318 * (c * t + d));
    }

    void main() {
      // Normalized coordinates (-1 to 1) with aspect ratio correction
      vec2 st = (gl_FragCoord.xy * 2.0 - u_resolution.xy) / min(u_resolution.x, u_resolution.y);
      vec2 mouse = (u_mouse * 2.0 - u_resolution.xy) / min(u_resolution.x, u_resolution.y);

      // Magnetic pull toward mouse
      vec2 orbCenter = mix(vec2(0.0), mouse, 0.35 * u_hover);
      vec2 pos = st - orbCenter;
      float d = length(pos);

      // Liquid wave surface deformation
      float angle = atan(pos.y, pos.x);
      float speed = u_time * (1.2 + u_activity * 1.5);
      float harmonic = sin(angle * 4.0 + speed) * 0.045
                     + cos(angle * 7.0 - speed * 0.8) * 0.025
                     + sin(angle * 2.0 + speed * 1.6) * 0.035;

      // Base sphere radius
      float baseRadius = 0.52 + harmonic * (0.8 + 0.4 * u_hover);

      // Shockwave ripple expansion from click/tap
      if (u_shockwave > 0.001) {
        float waveDist = abs(d - (1.0 - u_shockwave) * 0.9);
        baseRadius += sin(waveDist * 28.0) * 0.05 * u_shockwave;
      }

      // Fresnel rim glow
      float rim = 0.028 / (abs(d - baseRadius) + 0.015);

      // Inner liquid refraction & chromatic ribbons
      float inner = smoothstep(baseRadius + 0.02, baseRadius - 0.42, d);
      float swirl = sin(d * 9.0 - speed * 1.4 + angle * 2.5);
      float caustics = cos(pos.x * 12.0 + speed) * sin(pos.y * 12.0 - speed) * 0.5 + 0.5;

      // Base color blending
      vec3 col = palette(d * 1.5 + angle * 0.2 + speed * 0.1) * rim * 1.25;
      col += palette(swirl * 0.35 + d * 0.8 + speed * 0.15) * inner * (0.75 + caustics * 0.35);

      // Accent gold/cyan highlights
      vec3 cyanHighlight = vec3(0.05, 0.85, 0.98) * pow(max(0.0, 1.0 - d * 1.8), 2.2);
      vec3 amberWarmth = vec3(0.98, 0.65, 0.15) * pow(max(0.0, 0.6 - abs(pos.x - 0.15)), 3.0) * (0.4 + u_activity * 0.6);
      col += (cyanHighlight + amberWarmth) * inner;

      // Smooth outer atmospheric falloff
      float alpha = smoothstep(baseRadius + 0.35, baseRadius - 0.05, d);
      gl_FragColor = vec4(col * alpha, alpha * (inner * 0.95 + rim * 0.45));
    }
  `;

  class AiOrb {
    constructor(canvasElement, options = {}) {
      this.canvas = typeof canvasElement === 'string'
        ? document.getElementById(canvasElement)
        : canvasElement;

      if (!this.canvas) return;

      this.options = Object.assign({
        interactive: true,
        activity: 0.0, // 0.0 = idle/standby, 1.0 = heavy processing
      }, options);

      this.gl = this.canvas.getContext('webgl', { alpha: true, antialias: true, premultipliedAlpha: false });
      if (!this.gl) {
        this.fallback2D();
        return;
      }

      this.targetMouse = { x: 0, y: 0 };
      this.currentMouse = { x: 0, y: 0 };
      this.hoverState = 0.0;
      this.targetHover = 0.0;
      this.shockwave = 0.0;
      this.activity = this.options.activity;
      this.isRunning = false;
      this.startTime = performance.now();

      this.initGL();
      this.bindEvents();
      this.start();
    }

    initGL() {
      const gl = this.gl;
      const vs = this.compileShader(gl.VERTEX_SHADER, VERTEX_SHADER);
      const fs = this.compileShader(gl.FRAGMENT_SHADER, FRAGMENT_SHADER);

      this.program = gl.createProgram();
      gl.attachShader(this.program, vs);
      gl.attachShader(this.program, fs);
      gl.linkProgram(this.program);

      gl.useProgram(this.program);

      // Full quad buffer
      const buffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
        -1, -1,
         1, -1,
        -1,  1,
        -1,  1,
         1, -1,
         1,  1
      ]), gl.STATIC_DRAW);

      const posLoc = gl.getAttribLocation(this.program, 'a_position');
      gl.enableVertexAttribArray(posLoc);
      gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

      this.uniforms = {
        resolution: gl.getUniformLocation(this.program, 'u_resolution'),
        mouse: gl.getUniformLocation(this.program, 'u_mouse'),
        time: gl.getUniformLocation(this.program, 'u_time'),
        hover: gl.getUniformLocation(this.program, 'u_hover'),
        shockwave: gl.getUniformLocation(this.program, 'u_shockwave'),
        activity: gl.getUniformLocation(this.program, 'u_activity'),
      };

      this.resize();
    }

    compileShader(type, source) {
      const gl = this.gl;
      const shader = gl.createShader(type);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        console.warn('AiOrb Shader error:', gl.getShaderInfoLog(shader));
        gl.deleteShader(shader);
        return null;
      }
      return shader;
    }

    resize() {
      if (!this.canvas) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const rect = this.canvas.getBoundingClientRect();
      const width = Math.max(rect.width, 100);
      const height = Math.max(rect.height, 100);

      this.canvas.width = Math.round(width * dpr);
      this.canvas.height = Math.round(height * dpr);
      if (this.gl) {
        this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
      }
    }

    bindEvents() {
      if (!this.options.interactive) return;

      window.addEventListener('resize', () => this.resize(), { passive: true });

      const onPointerMove = (clientX, clientY) => {
        const rect = this.canvas.getBoundingClientRect();
        this.targetMouse.x = (clientX - rect.left) * (this.canvas.width / rect.width);
        this.targetMouse.y = (rect.bottom - clientY) * (this.canvas.height / rect.height);
        this.targetHover = 1.0;
      };

      this.canvas.addEventListener('mousemove', (e) => onPointerMove(e.clientX, e.clientY), { passive: true });
      this.canvas.addEventListener('mouseenter', () => { this.targetHover = 1.0; });
      this.canvas.addEventListener('mouseleave', () => {
        this.targetHover = 0.0;
        this.targetMouse.x = this.canvas.width / 2;
        this.targetMouse.y = this.canvas.height / 2;
      });

      this.canvas.addEventListener('touchmove', (e) => {
        if (e.touches.length > 0) {
          onPointerMove(e.touches[0].clientX, e.touches[0].clientY);
        }
      }, { passive: true });

      this.canvas.addEventListener('pointerdown', () => {
        this.triggerShockwave();
      });

      // Pause when hidden
      if ('IntersectionObserver' in window) {
        const observer = new IntersectionObserver((entries) => {
          entries.forEach(entry => {
            if (entry.isIntersecting) this.start();
            else this.stop();
          });
        }, { threshold: 0.1 });
        observer.observe(this.canvas);
      }
    }

    triggerShockwave() {
      this.shockwave = 1.0;
    }

    setActivity(level) {
      this.activity = Math.max(0, Math.min(1, level));
    }

    start() {
      if (this.isRunning) return;
      this.isRunning = true;
      const render = () => {
        if (!this.isRunning) return;
        this.draw();
        requestAnimationFrame(render);
      };
      requestAnimationFrame(render);
    }

    stop() {
      this.isRunning = false;
    }

    draw() {
      const gl = this.gl;
      if (!gl || !this.program) return;

      const elapsed = (performance.now() - this.startTime) * 0.001;

      // Damped spring mouse follow
      this.currentMouse.x += (this.targetMouse.x - this.currentMouse.x) * 0.08;
      this.currentMouse.y += (this.targetMouse.y - this.currentMouse.y) * 0.08;
      this.hoverState += (this.targetHover - this.hoverState) * 0.06;

      // Shockwave decay
      if (this.shockwave > 0.001) {
        this.shockwave *= 0.94;
      } else {
        this.shockwave = 0.0;
      }

      gl.useProgram(this.program);
      gl.uniform2f(this.uniforms.resolution, this.canvas.width, this.canvas.height);
      gl.uniform2f(this.uniforms.mouse, this.currentMouse.x, this.currentMouse.y);
      gl.uniform1f(this.uniforms.time, elapsed);
      gl.uniform1f(this.uniforms.hover, this.hoverState);
      gl.uniform1f(this.uniforms.shockwave, this.shockwave);
      gl.uniform1f(this.uniforms.activity, this.activity);

      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }

    fallback2D() {
      const ctx = this.canvas.getContext('2d');
      if (!ctx) return;
      const draw2D = () => {
        const w = this.canvas.width;
        const h = this.canvas.height;
        ctx.clearRect(0, 0, w, h);
        const grad = ctx.createRadialGradient(w/2, h/2, 10, w/2, h/2, w/2 - 10);
        grad.addColorStop(0, '#0284c7');
        grad.addColorStop(0.5, '#8b5cf6');
        grad.addColorStop(1, 'transparent');
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(w/2, h/2, w/2 - 10, 0, Math.PI * 2);
        ctx.fill();
      };
      draw2D();
    }
  }

  global.AiOrb = AiOrb;
})(typeof window !== 'undefined' ? window : this);
