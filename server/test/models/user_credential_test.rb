require "test_helper"

# The key that pays for a turn.
#
# Article P2 as amended (#304): a server may hold one, and only when it is exactly
# one person's, encrypted, and never readable back. The three clauses are three
# tests, because an article whose conditions are not each checked somewhere is a
# paragraph rather than a rule.
class UserCredentialTest < ActiveSupport::TestCase
  setup { @alice = user(name: "Alice") }

  test "the secret is not in the database in a form anybody can read" do
    UserCredential.create!(user: @alice, provider: "anthropic", secret: "sk-ant-notreal-0001")

    stored = UserCredential.connection.select_value(
      "SELECT secret FROM user_credentials ORDER BY id DESC LIMIT 1"
    )

    assert_not_includes stored.to_s, "sk-ant-notreal-0001",
                        "a key readable in a database dump is a key that leaked with the backup"
    assert_equal "sk-ant-notreal-0001", UserCredential.last.secret,
                 "and it still has to be usable"
  end

  test "one person, one provider — a second replaces rather than accumulates" do
    UserCredential.create!(user: @alice, provider: "anthropic", secret: "first")

    UserCredential.remember(user: @alice, provider: "anthropic", secret: "second")

    assert_equal 1, UserCredential.where(user: @alice, provider: "anthropic").count
    assert_equal "second", UserCredential.last.secret
  end

  # The whole of the prohibition, stated as a mechanism rather than as a promise.
  test "a credential belonging to nobody in particular is refused" do
    orphan = UserCredential.new(provider: "anthropic", secret: "shared-team-key")

    assert_not orphan.valid?
    assert_match(/one person/i, orphan.errors.full_messages.join,
                 "the refusal says why, because the why is the article")
  end

  test "nothing hands the secret back" do
    credential = UserCredential.create!(user: @alice, provider: "anthropic", secret: "sk-ant-notreal-0002")

    # Whatever a controller or a log reaches for, the secret is not in it.
    assert_not_includes credential.describe.to_json, "sk-ant-notreal-0002"
    assert_not_includes credential.inspect, "sk-ant-notreal-0002"
  end
end
