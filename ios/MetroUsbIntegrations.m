#import "MetroUsbIntegrations.h"

#if DEBUG

#import <dns_sd.h>
#import <objc/message.h>

static DNSServiceRef advertisement = NULL;

@implementation MetroUsbIntegrations

+ (void)advertiseMetroOnPort:(uint16_t)port name:(NSString *)name
{
  [self stopAdvertising];

  // TXT "name" is what expo-dev-launcher shows in its list of dev servers.
  TXTRecordRef txt;
  TXTRecordCreate(&txt, 0, NULL);
  const char *value = name.UTF8String;
  TXTRecordSetValue(&txt, "name", (uint8_t)MIN(strlen(value), 255), value);

  // LocalOnly: visible to apps on this device, never on the network. The SRV target is "localhost." so a browser
  // that resolves it connects to the relay's loopback listener (and dev launchers pin the resolved connection to
  // the interface the service was found on, which for LocalOnly is loopback).
  DNSServiceErrorType error = DNSServiceRegister(&advertisement, 0, kDNSServiceInterfaceIndexLocalOnly, name.UTF8String,
                                                 "_expo._tcp", NULL, "localhost.", htons(port),
                                                 TXTRecordGetLength(&txt), TXTRecordGetBytesPtr(&txt), NULL, NULL);
  TXTRecordDeallocate(&txt);
  if (error != kDNSServiceErr_NoError) {
    NSLog(@"[metro-usb] Bonjour advertisement failed: %d", error);
    advertisement = NULL;
    return;
  }
  DNSServiceSetDispatchQueue(advertisement, dispatch_get_main_queue());
}

+ (void)stopAdvertising
{
  if (advertisement) {
    DNSServiceRefDeallocate(advertisement);
    advertisement = NULL;
  }
}

+ (BOOL)openInDevLauncherIfIdle:(NSURL *)url
{
  // Looked up at runtime so the relay doesn't depend on expo-dev-launcher (plain React Native apps have no launcher).
  Class launcher = NSClassFromString(@"EXDevLauncherController");
  SEL shared = NSSelectorFromString(@"sharedInstance");
  SEL isRunning = NSSelectorFromString(@"isAppRunning");
  SEL load = NSSelectorFromString(@"loadApp:onSuccess:onError:");
  if (!launcher || ![launcher respondsToSelector:shared]) {
    return NO;
  }
  id controller = ((id (*)(id, SEL))objc_msgSend)(launcher, shared);
  if (![controller respondsToSelector:isRunning] || ![controller respondsToSelector:load]) {
    return NO;
  }
  // Never take over an app that's already running (e.g. loaded from somewhere else).
  if (((BOOL (*)(id, SEL))objc_msgSend)(controller, isRunning)) {
    return NO;
  }
  ((void (*)(id, SEL, NSURL *, id, id))objc_msgSend)(controller, load, url, nil, nil);
  return YES;
}

@end
#endif
