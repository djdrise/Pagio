'use strict';

// Подпись macOS ad-hoc.
//
// Electron приходит подписанным, но подпись эта «linker-signed»: её ставит
// компоновщик, и покрывает она только сам бинарник. Стоит electron-builder
// переименовать бандл и положить внутрь app.asar, как подпись перестаёт
// сходиться с содержимым: идентификатор в ней остаётся Electron, Info.plist
// не покрыт, ресурсы не запечатаны. codesign --verify на таком пакете падает,
// а на Apple Silicon ядро отказывается запускать код с негодной подписью.
//
// Своего сертификата у проекта нет, и заверять у Apple нечем. Но ad-hoc
// подписи достаточно, чтобы система дала программе запуститься: она не делает
// пакет доверенным (Gatekeeper всё равно спросит разрешение при первом
// запуске), зато делает его целым.
//
// Именно afterPack, а не afterSign: afterPack вызывается до шага подписи, а
// afterSign при пропущенной подписи не вызывается вовсе — а она у нас всегда
// пропущена, потому что искать сертификат нечего.

const { execFileSync } = require('node:child_process');
const path = require('node:path');

exports.default = async function adhocSign(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);

  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });

  // Проверяем тут же: пусть сборка падает у нас, а не программа у пользователя.
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });

  console.log(`  • ad-hoc подпись  app=${path.relative(process.cwd(), app)}`);
};
