#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/// The parts of the relay that talk to the rest of the app: Bonjour (so dev launchers list the relayed Metro)
/// and expo-dev-launcher (to open it). Both are best-effort and silently do nothing when unavailable.
@interface MetroUsbIntegrations : NSObject

/// Advertises `_expo._tcp` on this device only, pointing at localhost:`port`, with a display name.
+ (void)advertiseMetroOnPort:(uint16_t)port name:(NSString *)name;
+ (void)stopAdvertising;

/// If expo-dev-launcher is present and no app is running yet, loads `url`. Must be called on the main thread.
+ (BOOL)openInDevLauncherIfIdle:(NSURL *)url;

@end

NS_ASSUME_NONNULL_END
