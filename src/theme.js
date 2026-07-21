import { createTheme } from '@mantine/core';

// Monochromatyczny motyw e-ink (papier BOOX) — skala od papieru do atramentu.
const ink = [
  '#faf7ef', // 0 --bg
  '#ede6d9', // 1 --bg-side / --gold-dim
  '#e6ddcd', // 2 --bg-hover
  '#c8c2b8', // 3 --border-soft
  '#a29c91', // 4
  '#6e6a61', // 5 --border / --txt-3
  '#3f3f3a', // 6 --txt-2
  '#2e2e2e', // 7 --green
  '#0f0f0f', // 8 --txt-1
  '#000000', // 9 --gold
];

export const theme = createTheme({
  colors: { ink },
  primaryColor: 'ink',
  primaryShade: 9,
  black: '#0f0f0f',
  defaultRadius: 'sm',
  fontFamily: 'inherit',
  respectReducedMotion: true,
  components: {
    Modal: {
      defaultProps: {
        overlayProps: { opacity: 0.35, blur: 0 },
        closeButtonProps: { 'aria-label': 'Zamknij' },
      },
    },
  },
});
