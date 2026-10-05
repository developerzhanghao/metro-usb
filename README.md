# metro-usb

**Run a React Native / Expo debug build on a cabled iPhone without Wi-Fi.** Metro goes over the USB cable, like `adb reverse` does on Android.

> Community project. Not affiliated with Meta's Metro bundler or with Expo.

[中文说明](#中文说明)

## Why

A debug build loads its JavaScript from Metro on your Mac, over the network. That fails when:

- the café, coworking space or hotel Wi-Fi uses **client isolation**: the phone and the Mac can't see each other;
- the office network blocks device-to-device traffic;
- there is no shared network at all.

Android has `adb reverse tcp:8081 tcp:8081`. iOS has nothing like it. `iproxy 8081:8081` is often suggested, but it forwards the other way: from the Mac into the phone. Tunnels such as `expo start --tunnel` work, but they route every reload through a server abroad.

`metro-usb` carries Metro over the cable you already have plugged in. You don't need a hotspot, an app on the phone, or a VPN.

## Quick start

```bash
npm install --save-dev metro-usb      # or: pnpm add -D / yarn add -D
```

Rebuild the iOS app once, since this adds a small native piece:

```bash
npx expo run:ios --device             # Expo (dev client / prebuild)
# or: cd ios && pod install, then build from Xcode   (bare React Native)
```

Then, with the iPhone on the cable, in your app's folder:

```bash
npx metro-usb
```

That's the whole workflow. If Metro isn't running, it starts it in the same terminal (`expo start`, or `react-native start` without Expo). Expo's keys (`r` to reload and so on) work as usual, and Ctrl+C stops both. If Metro is already running, it only relays.

Open the app:

- **Expo dev client**: it opens Metro by itself as soon as the cable link is up. It is also listed as **"Metro over USB · <your Mac>"** in the launcher.
- **Anything else**: point the app at `http://localhost:8081`. In the React Native dev menu, use *Configure Bundler* → `localhost:8081`.

Hot reload, the dev menu and other dev-server traffic all go over the cable.

## Options

```
npx metro-usb [--port <port>]... [--verbose] [--no-start] [-- <command>...]

  --port 8081      forward the phone's localhost:8081 to the Mac's localhost:8081 (default)
  --port 8787      repeat to forward more, e.g. a local API the app calls at http://localhost:8787
  --verbose, -v    log every connection and how many bytes went each way
  --no-start       only relay; don't start Metro
  -- <command>     start this instead of the default, e.g. `npx metro-usb -- npx expo start --clear`
```

Ports are mirrored (same number on both sides). Metro writes its own port into the manifest that the app follows, so a different port on the phone would break bundle loading.

## How it works

```
 iPhone (debug build)                                   Mac
┌──────────────────────────────┐   USB cable    ┌──────────────────────────┐
│ app ──► 127.0.0.1:8081 ──┐   │  (usbmuxd)     │  npx metro-usb           │
│                          │   │                │      │                   │
│   metro-usb relay ◄──────┴───┼── control ◄────┼──────┘                   │
│   (listens on loopback)      │   connection   │      └──► localhost:8081 │
└──────────────────────────────┘                │           (Metro)        │
                                                └──────────────────────────┘
```

usbmuxd, the daemon Xcode uses (built into macOS), can only open connections **from the Mac into a port on the phone**. So the direction is flipped:

1. In debug builds, a tiny relay starts with the app and listens on the phone's **loopback only** (`127.0.0.1`, `::1`). It starts at load time, before React Native asks for the bundle.
2. `npx metro-usb` finds the cabled iPhone through usbmuxd and dials into the relay. Every connection the app makes to `localhost:8081` is carried over that one link and replayed against Metro on the Mac.
3. While the link is up, the relay advertises Metro to the Expo dev launcher via device-local Bonjour. If no app is running yet, it opens Metro.

## Safety

- **Debug builds only.** All native code is inside `#if DEBUG`, so release builds contain none of it.
- **Loopback only.** Nothing on Wi-Fi or cellular can reach the relay. Only a Mac the iPhone trusts (paired over USB) can open it, the same trust Xcode relies on.
- **Off in the Simulator.** The Simulator shares the Mac's network and reaches Metro directly. A relay there would shadow the Mac's own `localhost:8081`, so it doesn't start.
- **Doesn't get in the way.** Without the cable or the CLI, the relay idles: no advertising and no auto-open. Your normal Wi-Fi workflow is unchanged.

## Requirements and status

- iOS 15.1+, React Native with CocoaPods autolinking (bare or Expo prebuild / dev client).
- macOS for the CLI. Linux with `usbmuxd` should work but is untested. Windows isn't supported yet.
- **0.x, experimental.** Tested with Expo SDK 56 on a physical iPhone.

Known gaps:

- Two `metro-usb` processes attached to the same phone keep replacing each other's connection. Run only one.

- Bare React Native apps don't switch to `localhost` automatically yet. Set it once via *Configure Bundler*.
- Build configurations not named `Debug` may lack the `DEBUG` flag. Add it to `GCC_PREPROCESSOR_DEFINITIONS` and `SWIFT_ACTIVE_COMPILATION_CONDITIONS`.

Issues and PRs are welcome.

## Troubleshooting

| You see | Try |
|---|---|
| `waiting for an iPhone on USB…` forever | Unlock the phone and tap **Trust** when asked. Check that it shows up in Xcode's *Devices*. |
| `waiting for the app…` | Open the app. Make sure it's a **debug** build made **after** installing metro-usb. |
| `nothing listening on localhost:8081` | Metro isn't running: run `npx metro-usb` from your app's folder, or start Metro yourself. |
| The app can't load the bundle | Run `npx metro-usb --verbose` and check that requests appear and bytes flow back. |

---

## 中文说明

**在没有 Wi-Fi，或者 Wi-Fi 开了客户端隔离（咖啡店、共享办公、酒店）时，让插着数据线的 iPhone 照常连上 Mac 上的 Metro。** 相当于 iOS 版的 `adb reverse`，不用开热点，手机上也不用装任何 App。

```bash
npm i -D metro-usb            # 装完重新编译一次 iOS App
npx metro-usb                 # 插上数据线，在项目目录里运行这一条就够了
```

Metro 没在跑的话，它会在同一个终端里帮你启动（`expo start` 或 `react-native start`），按 Ctrl+C 两个一起退出。

使用 Expo 开发版时，数据线连通后会自动打开 Metro。开发版的列表里也会出现 "Metro over USB · 你的 Mac"。其他情况下，在 App 里把地址设为 `http://localhost:8081` 即可。

**原理**：iOS 的 usbmuxd 只允许 Mac 主动连进手机的端口，所以方向是反过来的。Debug 版 App 启动时在手机的本机回环地址上开一个中转，`npx metro-usb` 通过数据线连进去，再把 App 发往 `localhost:8081` 的连接转发给 Mac 上的 Metro。

**安全**：只在 Debug 版本中存在，只监听本机回环地址，模拟器里不启动。不插线时完全不影响平时用 Wi-Fi 开发。

## License

MIT
