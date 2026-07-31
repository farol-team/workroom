require "test_helper"

class SeedsTest < ActiveSupport::TestCase
  test "the seed refuses to run in production" do
    # `db:prepare` seeds a database it just created, and the container entrypoint
    # runs it on every boot. Without this, a first deploy hands out `dev-alice`
    # as a working bearer token on a working server.
    seeds = Rails.root.join("db/seeds.rb").read

    assert_match(/Rails\.env\.production\?/, seeds,
                 "the seed must know where it is running")
    assert_match(/exit/, seeds, "and must stop rather than carry on")
  end

  test "the accounts it creates are development ones" do
    seeds = Rails.root.join("db/seeds.rb").read

    assert_match(/provider = "dev"/, seeds,
                 "if these ever stop being marked as development accounts, the guard above is the only thing left")
  end
end
