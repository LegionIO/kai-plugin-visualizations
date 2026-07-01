import { PanelView } from './components/PanelView';
import { SettingsView } from './components/SettingsView';
import { PLUGIN_NAME } from '../shared/constants.js';

export function register(env: {
  React: unknown;
  registerComponents: (pluginName: string, components: Record<string, unknown>) => void;
}) {
  (globalThis as Record<string, unknown>).React = env.React;
  env.registerComponents(PLUGIN_NAME, {
    PanelView,
    SettingsView,
  });
}
