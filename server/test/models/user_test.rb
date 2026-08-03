require "test_helper"

class UserTest < ActiveSupport::TestCase
  def sign_up(email, name: "Sam Ray")
    User.create!(name:, email:, provider: "test", uid: email)
  end

  # What somebody types after an `@` is neither the name a colleague reads nor
  # the address a provider knows — it comes from the address because that is the
  # name people already answer to.
  test "the handle comes from the address, not from the name" do
    assert_equal "sam.ray", sign_up("sam.ray@example.test").handle
  end

  test "an address that is not a handle is cut down to one" do
    assert_equal "samray", sign_up("Sam+Ray@example.test").handle
  end

  # Two people of the same name is the ordinary case, and the second one must
  # not meet a unique index while they are signing in.
  test "the second Sam Ray gets a handle of their own" do
    first = sign_up("sam.ray@example.test")
    second = sign_up("sam.ray@other.test")

    assert_equal "sam.ray", first.handle
    refute_equal first.handle, second.handle
    assert_equal "sam.ray2", second.handle
  end

  test "the third one is not the second one either" do
    sign_up("sam.ray@example.test")
    sign_up("sam.ray@other.test")

    assert_equal "sam.ray3", sign_up("sam.ray@third.test").handle
  end

  test "an address with nothing usable in it still yields a handle" do
    assert_equal "person", sign_up("!!!@example.test").handle
  end

  test "a handle somebody chose is left alone" do
    person = User.create!(name: "Sam Ray", email: "sam.ray@example.test",
                          provider: "test", uid: "sam.ray@example.test", handle: "sammy")

    assert_equal "sammy", person.handle
  end

  test "membership in a channel is what member_of? answers" do
    room = channel
    inside = user(name: "Inside")
    outside = user(name: "Outside")
    room.memberships.create!(user: inside)

    assert inside.member_of?(room)
    refute outside.member_of?(room)
  end
end
