import type { App } from 'electron';

export const appUserModelId = 'com.squirrel.TaskRelay.TaskRelay';
type LoginApp = Pick<App, 'getLoginItemSettings' | 'setLoginItemSettings' | 'setAppUserModelId'>;

// Windows compares the registered command literally for openAtLogin, while
// launchItems matches executable paths case-insensitively and includes approval.
export function loginSettings(app: LoginApp, launchPath: string) {
  const options = {path: launchPath, args: [] as string[]};
  const ownItem = () => app.getLoginItemSettings(options).launchItems.find(
    item => item.name === appUserModelId && item.scope === 'user' && item.args.length === 0,
  );
  const legacy = app.getLoginItemSettings();
  if (legacy.openAtLogin) app.setLoginItemSettings({openAtLogin: false});
  app.setAppUserModelId(appUserModelId);
  // An existing stable entry, including an OS-disabled entry, wins over migration.
  if (legacy.openAtLogin && !ownItem()) app.setLoginItemSettings({
    ...options, name: appUserModelId, openAtLogin: true,
    enabled: legacy.executableWillLaunchAtLogin,
  });
  return {
    enabled: () => ownItem()?.enabled ?? false,
    setEnabled: (enabled: boolean) => app.setLoginItemSettings({
      ...options, name: appUserModelId, openAtLogin: enabled, enabled,
    }),
  };
}
