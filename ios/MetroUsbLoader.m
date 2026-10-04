#import <Foundation/Foundation.h>

#if DEBUG
#if __has_include(<MetroUsb/MetroUsb-Swift.h>)
#import <MetroUsb/MetroUsb-Swift.h>
#else
#import "MetroUsb-Swift.h"
#endif

// Starts the relay as the binary loads, before React Native asks for the JS bundle: the bundle itself comes
// through the relay, so JS can't be the one to start it. Debug builds only; release builds contain none of this.
@interface MetroUsbLoader : NSObject
@end

@implementation MetroUsbLoader
+ (void)load {
  [MetroUsb.shared start];
}
@end
#endif
