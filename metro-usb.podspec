require 'json'

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))

Pod::Spec.new do |s|
  s.name          = 'metro-usb'
  s.module_name   = 'MetroUsb'
  s.version       = package['version']
  s.summary       = package['description']
  s.license       = package['license']
  s.author        = package['author']
  s.homepage      = package['homepage']
  s.platforms     = { :ios => '15.1' }
  s.swift_version = '5.9'
  s.source        = { :git => 'https://github.com/developerzhanghao/metro-usb.git', :tag => "v#{s.version}" }

  # Everything is wrapped in #if DEBUG: release builds compile to nothing.
  s.source_files  = 'ios/**/*.{h,m,swift}'
  s.frameworks    = 'Network'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
end
