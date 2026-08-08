require "test_helper"

# The token is the whole of the boundary: what it names is what the agent may
# address, and everything else is refused before the store hears about it. So the
# things worth proving are that it round-trips, that it stops being valid, and
# that it cannot be edited into naming something else.
class Memory::ScopeTokenTest < ActiveSupport::TestCase
  PREFIXES = [ "viking://resources/channels/sales/", "viking://org/" ].freeze

  test "a minted token verifies back to what it was minted for" do
    token = Memory::ScopeToken.mint(account: "acct-1", user_id: 7, prefixes: PREFIXES)

    claims = Memory::ScopeToken.verify(token)

    assert_equal "acct-1", claims[:account]
    assert_equal 7, claims[:user_id]
    assert_equal PREFIXES, claims[:prefixes]
  end

  test "an expired token is refused" do
    token = Memory::ScopeToken.mint(account: "acct-1", user_id: 7, prefixes: PREFIXES,
                                    ttl: -1.second)

    assert_nil Memory::ScopeToken.verify(token)
  end

  test "a token whose payload was edited is refused" do
    token = Memory::ScopeToken.mint(account: "acct-1", user_id: 7, prefixes: PREFIXES)
    payload, signature = token.delete_prefix(Memory::ScopeToken::PREFIX).split(".", 2)
    edited = Base64.urlsafe_encode64(
      { a: "acct-1", u: 7, p: [ "viking://" ], exp: 1.hour.from_now.to_i }.to_json, padding: false
    )

    assert_nil Memory::ScopeToken.verify("#{Memory::ScopeToken::PREFIX}#{edited}.#{signature}")
    assert_not_equal payload, edited, "the fixture must actually differ from the original"
  end

  test "a token signed by something else is refused" do
    payload = Base64.urlsafe_encode64(
      { a: "acct-1", u: 7, p: PREFIXES, exp: 1.hour.from_now.to_i }.to_json, padding: false
    )
    forged = Base64.urlsafe_encode64(
      OpenSSL::HMAC.digest("SHA256", "not the server's secret", payload), padding: false
    )

    assert_nil Memory::ScopeToken.verify("#{Memory::ScopeToken::PREFIX}#{payload}.#{forged}")
  end

  test "anything that is not one of our tokens is refused rather than parsed" do
    assert_nil Memory::ScopeToken.verify(nil)
    assert_nil Memory::ScopeToken.verify("")
    assert_nil Memory::ScopeToken.verify("Bearer something")
    assert_nil Memory::ScopeToken.verify("#{Memory::ScopeToken::PREFIX}no-signature")
  end
end
