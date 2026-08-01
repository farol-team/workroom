require "test_helper"

# A server reachable from a browser without TLS hands out its session cookie in
# clear text. There is one situation that earns the exception — a server with no
# certificate yet, reached by address — and the danger is that the exception
# outlives it, quietly downgrading every visitor once a certificate is in front.
class TlsConfigTest < ActiveSupport::TestCase
  ROOT       = Rails.root
  PRODUCTION = ROOT.join("config/environments/production.rb").read
  DEPLOY     = YAML.load_file(ROOT.join("config/deploy.yml"), aliases: true)

  test "TLS is on unless the deployment names what it is giving up" do
    assert_match(/config\.force_ssl\s*=\s*!insecure/, PRODUCTION,
      "force_ssl must default on — a production default of off is not a default anybody chose")
    assert_match(/config\.assume_ssl\s*=\s*!insecure/, PRODUCTION,
      "assume_ssl must follow force_ssl, or Rails builds http:// urls behind a proxy that terminated TLS")
    assert_match(/insecure\s*=\s*ENV\["WORKROOM_INSECURE_HTTP"\]\s*==\s*"true"/, PRODUCTION,
      "the exception must be opt-in by an explicitly named variable, not by any truthy value")
  end

  test "plain HTTP and a certificate cannot be asked for at the same time" do
    insecure = DEPLOY.dig("env", "clear", "WORKROOM_INSECURE_HTTP").to_s == "true"
    ssl      = DEPLOY.dig("proxy", "ssl") == true

    refute insecure && ssl,
      "the proxy holds a certificate while the application refuses to use it — every visitor is downgraded"
    refute ssl && DEPLOY.dig("proxy", "host").to_s.empty?,
      "a certificate cannot be issued without a host name for it"
  end
end
